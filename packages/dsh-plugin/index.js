// @mebular/dsh-plugin host plugin.
//
// Boundary: this file is pure ESM with Node built-ins only. It never imports
// @mebular/*, never reads Mebular configuration or secrets, and never writes to
// the Mebular home directory. The single external module is the official DSH
// MCP bridge peer, loaded lazily at apply time (never at module top level).
//
// Lifecycle:
//   - `attach` (default): only probe an existing daemon. Never spawn or stop.
//   - `managed`: reuse a healthy daemon; otherwise spawn `mebular serve` once
//     and stop only that child on plugin dispose. This is a process fallback,
//     not a service install, and never touches an external/service daemon.
//
// The MCP bridge mounts the official @deepseek-ai/dsh-mcp-client plugin on the
// same daemon URL the panel uses, so both follow one discovery order:
// explicit daemonUrl > MEBULAR_HTTP_PORT > <home>/runtime.json > 7331.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export const name = '@mebular/dsh-plugin';

export const EMBED_INFO_PATH = '/mebular/embed-info';

/** Console discovery contract version, shared with packages/mcp. */
export const EMBED_PROTOCOL = 1;

/** Browser global injected by the host through DSH's webServer.tapIndex. */
export const PANEL_GLOBAL = '__MEBULAR_DSH__';

const DEFAULT_PORT = 7331;
const DEFAULT_PROBE_TIMEOUT_MS = 1200;
const DEFAULT_CACHE_TTL_MS = 1000;
const DEFAULT_MANAGED_START_TIMEOUT_MS = 20000;
const DEFAULT_MANAGED_POLL_INTERVAL_MS = 500;
const DEFAULT_MANAGED_KILL_GRACE_MS = 2000;
const DEFAULT_BRIDGE_POLL_INTERVAL_MS = 2000;
const DEFAULT_CLI_NAME = 'mebular';
const RUNTIME_FILE = 'runtime.json';
const MAX_LOG_LINE = 500;

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
 * touches config.json, identity, or secrets.
 *
 * @param {unknown} input
 * @param {{
 *   warn?: (message: string) => void,
 *   env?: Record<string, string | undefined>,
 *   home?: string,
 *   runtime?: unknown,
 *   pidAlive?: (pid: number) => boolean,
 * } | ((message: string) => void)} [options]
 * @returns {{ daemonUrl: string, lifecycle: 'attach' | 'managed', panel: boolean, cliPath?: string }}
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
    if (value === 'attach' || value === 'managed') lifecycle = value;
    else notify(`invalid lifecycle ${describeValue(config.lifecycle)}; using "attach"`);
  }

  let panel = true;
  if (config.panel !== undefined) {
    if (typeof config.panel === 'boolean') panel = config.panel;
    else if (config.panel === 'on') panel = true;
    else if (config.panel === 'off') panel = false;
    else notify(`invalid panel ${describeValue(config.panel)}; using true`);
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
      const runtime = readRuntimeState(runtimeOptions);
      daemonUrl = runtimeDaemonUrl(runtime, { pidAlive: opts.pidAlive }) ?? `http://127.0.0.1:${DEFAULT_PORT}`;
    }
  }

  /** @type {{ daemonUrl: string, lifecycle: 'attach' | 'managed', panel: boolean, cliPath?: string }} */
  const resolved = {
    daemonUrl,
    lifecycle,
    panel,
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

/**
 * Build the non-sensitive status document returned to the DSH panel.
 *
 * - `status` is `up`, `down`, or `starting` (managed daemon boot).
 * - `mode` is the effective lifecycle; it degrades to `attach` when the
 *   managed CLI cannot be resolved.
 * - `managed` is true only while this plugin owns the running child process.
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
 *   mode?: 'attach' | 'managed',
 *   managed?: boolean,
 *   panel?: boolean,
 *   reason?: string | null,
 * }} [input]
 * @returns {{
 *   ok: boolean,
 *   status: 'up' | 'down' | 'starting',
 *   mode: 'attach' | 'managed',
 *   managed: boolean,
 *   panel: boolean,
 *   version: string | null,
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
  const version = typeof health?.version === 'string' && health.version.length > 0
    ? health.version
    : typeof embed?.version === 'string' && embed.version.length > 0
      ? embed.version
      : null;

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

  return {
    ok: status === 'up' && reason === null,
    status,
    mode,
    managed,
    panel,
    version,
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

/**
 * Create the daemon lifecycle state machine used by the host plugin.
 *
 * attach: probes only. managed: probes once, reuses a healthy daemon, or
 * spawns the resolved CLI exactly once and waits for /healthz with a bound.
 * dispose() sends SIGTERM only to a child this lifecycle started.
 *
 * @param {{
 *   config?: unknown,
 *   warn?: (message: string) => void,
 *   logger?: { info?: (message: string) => void, warn?: (message: string) => void },
 *   probe?: typeof probeDaemon,
 *   fetchImpl?: typeof fetch,
 *   spawnFn?: typeof spawn,
 *   resolveCli?: (context: { config: ReturnType<typeof resolveConfig> }) => string | null,
 *   exists?: (file: string) => boolean,
 *   env?: Record<string, string | undefined>,
 *   home?: string,
 *   runtime?: unknown,
 *   pidAlive?: (pid: number) => boolean,
 *   platform?: string,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<unknown>,
 *   timeoutMs?: number,
 *   cacheTtlMs?: number,
 *   startTimeoutMs?: number,
 *   pollIntervalMs?: number,
 *   killGraceMs?: number,
 * }} [options]
 * @returns {{
 *   start: () => Promise<{
 *     status: 'up' | 'down' | 'starting',
 *     mode: 'attach' | 'managed',
 *     managed: boolean,
 *     reason: string | null,
 *     reachable: boolean,
 *     health: Record<string, unknown> | null,
 *     embed: Record<string, unknown> | null,
 *   }>,
 *   inspect: () => Promise<{
 *     status: 'up' | 'down' | 'starting',
 *     mode: 'attach' | 'managed',
 *     managed: boolean,
 *     reason: string | null,
 *     reachable: boolean,
 *     health: Record<string, unknown> | null,
 *     embed: Record<string, unknown> | null,
 *   }>,
 *   refresh: () => Promise<unknown>,
 *   dispose: () => void,
 *   getState: () => {
 *     status: 'up' | 'down' | 'starting',
 *     mode: 'attach' | 'managed',
 *     managed: boolean,
 *     reason: string | null,
 *     reachable: boolean,
 *     health: Record<string, unknown> | null,
 *     embed: Record<string, unknown> | null,
 *   },
 * }}
 */
export function createDaemonLifecycle(options = {}) {
  const opts = isObject(options) ? options : {};
  const env = isObject(opts.env) ? opts.env : process.env;
  const platform = typeof opts.platform === 'string' ? opts.platform : process.platform;
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
  const cacheTtlMs = Number.isFinite(opts.cacheTtlMs) ? opts.cacheTtlMs : DEFAULT_CACHE_TTL_MS;
  const startTimeoutMs = Number.isFinite(opts.startTimeoutMs)
    ? opts.startTimeoutMs
    : DEFAULT_MANAGED_START_TIMEOUT_MS;
  const pollIntervalMs = Number.isFinite(opts.pollIntervalMs)
    ? opts.pollIntervalMs
    : DEFAULT_MANAGED_POLL_INTERVAL_MS;
  const killGraceMs = Number.isFinite(opts.killGraceMs)
    ? Math.max(0, opts.killGraceMs)
    : DEFAULT_MANAGED_KILL_GRACE_MS;
  const logHome = typeof opts.home === 'string' && opts.home.length > 0 ? opts.home : mebularHome(env);
  const logger = isObject(opts.logger) ? opts.logger : null;
  const resolveCli = typeof opts.resolveCli === 'function'
    ? opts.resolveCli
    : () => resolveCliPath({
      cliPath: config.cliPath,
      env,
      platform,
      exists: opts.exists,
    });

  let mode = config.lifecycle;
  let phase = config.lifecycle === 'managed' ? 'starting' : 'down';
  let managed = false;
  let child = null;
  let childState = 'none';
  /** @type {Promise<unknown> | null} */
  let terminating = null;
  let terminatingChild = null;
  let failureReason = null;
  let health = null;
  let embed = null;
  let reachable = false;
  let lastProbeAt = -Infinity;
  /** @type {Promise<unknown> | null} */
  let probing = null;
  /** @type {Promise<unknown> | null} */
  let startPromise = null;
  let disposed = false;

  function log(level, message) {
    safeLog(logger, level, message);
  }

  function currentSnapshot() {
    return {
      status: phase,
      mode,
      managed: managed && childState === 'running' && !disposed,
      reason: phase === 'down' ? failureReason : null,
      reachable: phase === 'up' ? true : reachable,
      health,
      embed,
    };
  }

  function applyProbe(result) {
    const value = isObject(result) ? result : {};
    health = isObject(value.health) ? value.health : null;
    embed = isObject(value.embed) ? value.embed : null;
    reachable = value.reachable === true;
    lastProbeAt = now();

    if (reachable) {
      phase = 'up';
      failureReason = null;
      if (childState !== 'running') managed = false;
      return;
    }
    if (phase === 'starting') return;
    phase = 'down';
    if (childState === 'exited' && mode === 'managed') {
      failureReason = 'managed_start_failed';
    } else if (failureReason !== 'managed_cli_missing' && failureReason !== 'managed_start_failed') {
      failureReason = null;
    }
  }

  async function runProbe() {
    try {
      const result = await probe({ daemonUrl: config.daemonUrl, fetchImpl, timeoutMs });
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
      return currentSnapshot();
    })().finally(() => {
      probing = null;
    });
    return probing;
  }

  function wireOutput(stream, level, cliPath) {
    if (stream === null || typeof stream !== 'object' || typeof stream.on !== 'function') return;
    try {
      stream.on('data', (chunk) => {
        const text = String(chunk ?? '');
        const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 20);
        for (const line of lines) {
          log(level, `managed daemon: ${redactLogLine(line, { home: logHome, cliPath })}`);
        }
      });
    } catch {
      // A broken stream must not break the lifecycle.
    }
  }

  function startChild(cliPath) {
    const port = daemonPortFromUrl(config.daemonUrl);
    const args = ['serve', '--port', String(port)];
    // Node cannot execute .cmd/.bat directly on Windows. The args are fixed and
    // the CLI path comes from local config/PATH, so shell quoting is not an
    // injection surface. Other platforms keep direct exec.
    const shell = platform === 'win32' && /\.(?:cmd|bat)$/i.test(cliPath);
    let proc;
    try {
      // Inherit the process environment: the Mebular CLI resolves its own home.
      proc = spawnFn(cliPath, args, {
        env: { ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        ...(shell ? { shell: true } : {}),
      });
    } catch (error) {
      log('warn', `managed daemon failed to spawn (${safeErrorCode(error)})`);
      return false;
    }
    if (proc === null || typeof proc !== 'object') {
      log('warn', 'managed daemon failed to spawn (no_child_process)');
      return false;
    }

    child = proc;
    childState = 'running';
    managed = true;
    // Never log the CLI path or the Mebular home.
    log('info', `managed daemon started on port ${port}`);

    const markExited = (event, detail) => {
      if (childState === 'exited') return;
      childState = 'exited';
      managed = false;
      if (disposed) return;
      if (phase !== 'starting') phase = 'down';
      log('warn', `managed daemon ${event}${detail ? `: ${detail}` : ''}`);
    };

    try {
      proc.once?.('error', (error) => markExited('failed', safeErrorCode(error)));
      proc.once?.('exit', (code, signal) => {
        markExited('exited', signal ? `signal ${signal}` : `code ${code}`);
      });
    } catch {
      // Event wiring failure is handled by the health wait and timeout.
    }
    wireOutput(proc.stdout, 'info', cliPath);
    wireOutput(proc.stderr, 'warn', cliPath);
    return true;
  }

  function signalChild(proc, signal) {
    try {
      proc.kill(signal);
    } catch (error) {
      log('warn', `failed to signal managed daemon (${safeErrorCode(error)})`);
    }
  }

  /**
   * Terminate a child this lifecycle started: SIGTERM, then SIGKILL after the
   * grace period. Resolves when the process exits or the escalation completes.
   * @param {unknown} proc
   */
  function terminateChild(proc) {
    if (proc === null || typeof proc !== 'object') return Promise.resolve();
    if (terminatingChild === proc && terminating !== null) return terminating;
    terminatingChild = proc;
    terminating = new Promise((resolve) => {
      let settled = false;
      /** @type {ReturnType<typeof setTimeout> | null} */
      let timer = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        try {
          proc.removeListener?.('exit', onExit);
        } catch {
          // Listener cleanup must never block disposal.
        }
        resolve();
      };
      const onExit = () => finish();
      try {
        proc.once?.('exit', onExit);
      } catch {
        // The timeout below still escalates.
      }
      signalChild(proc, 'SIGTERM');
      timer = setTimeout(() => {
        if (settled) return;
        log('warn', `managed daemon did not exit after SIGTERM within ${killGraceMs}ms; sending SIGKILL`);
        signalChild(proc, 'SIGKILL');
        finish();
      }, killGraceMs);
      timer.unref?.();
    });
    return terminating;
  }

  async function stopOwnedChild() {
    const proc = child;
    if (proc === null) return;
    if (childState !== 'running') {
      child = null;
      return;
    }
    await terminateChild(proc);
    if (child === proc) {
      child = null;
      childState = 'exited';
    }
    managed = false;
  }

  async function waitForManagedHealth() {
    const deadline = now() + startTimeoutMs;
    while (!disposed) {
      const result = await runProbe();
      if (disposed) return;
      applyProbe(result);
      if (reachable) return;
      if (childState === 'exited') {
        await stopOwnedChild();
        if (disposed) return;
        phase = 'down';
        failureReason = 'managed_start_failed';
        log('warn', 'managed daemon exited before becoming healthy');
        return;
      }
      if (now() >= deadline) {
        log('warn', `managed daemon did not become healthy within ${startTimeoutMs}ms`);
        // Only the child spawned above is stopped; an external daemon is never
        // touched here because child is null in attach-after-reuse paths.
        await stopOwnedChild();
        if (disposed) return;
        phase = 'down';
        failureReason = 'managed_start_failed';
        return;
      }
      await sleep(pollIntervalMs);
    }
  }

  async function ensureManaged() {
    const initial = await runProbe();
    if (disposed) return;
    applyProbe(initial);
    if (reachable) {
      log('info', 'reusing an existing Mebular daemon');
      return;
    }

    let cli = null;
    try {
      cli = resolveCli({ config });
    } catch {
      log('warn', 'managed CLI resolution failed; falling back to attach');
    }
    const cliPath = typeof cli === 'string' && cli.trim().length > 0 ? cli.trim() : null;
    if (cliPath === null) {
      mode = 'attach';
      phase = 'down';
      failureReason = 'managed_cli_missing';
      log('warn', 'managed lifecycle requested but no Mebular CLI was found; falling back to attach');
      return;
    }

    phase = 'starting';
    failureReason = null;
    if (!startChild(cliPath)) {
      phase = 'down';
      failureReason = 'managed_start_failed';
      return;
    }
    await waitForManagedHealth();
  }

  function start() {
    if (startPromise !== null) return startPromise;
    if (disposed) return Promise.resolve(currentSnapshot());
    startPromise = (async () => {
      try {
        if (config.lifecycle === 'managed') await ensureManaged();
        else await refresh();
      } catch (error) {
        log('warn', `lifecycle start failed (${safeErrorCode(error)})`);
        // A thrown start path must not leave an owned child behind. This never
        // touches a daemon the plugin did not spawn.
        await stopOwnedChild();
        phase = 'down';
        failureReason = mode === 'managed' ? 'managed_start_failed' : null;
      }
      return currentSnapshot();
    })();
    return startPromise;
  }

  async function inspect() {
    if (disposed) return currentSnapshot();
    if (phase === 'starting') return currentSnapshot();
    if (probing !== null) {
      await probing;
      return currentSnapshot();
    }
    if (now() - lastProbeAt < cacheTtlMs) return currentSnapshot();
    await refresh();
    return currentSnapshot();
  }

  function dispose() {
    const proc = child;
    const running = proc !== null && childState === 'running';
    disposed = true;
    child = null;
    childState = 'exited';
    managed = false;
    phase = 'down';
    // SIGTERM now, SIGKILL after killGraceMs. termination is intentionally not
    // awaited: DSH disposal is synchronous, and the timer still escalates.
    if (running) void terminateChild(proc);
  }

  return {
    start,
    inspect,
    refresh,
    dispose,
    getState: currentSnapshot,
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
        daemonUrl: config.daemonUrl,
        reachable: snapshot?.reachable === true,
        health: isObject(snapshot?.health) ? snapshot.health : null,
        embed: isObject(snapshot?.embed) ? snapshot.embed : null,
        status: snapshot?.status,
        mode: snapshot?.mode,
        managed: snapshot?.managed === true,
        panel: config.panel,
        reason: typeof snapshot?.reason === 'string' ? snapshot.reason : null,
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
        }))
        .catch(() => buildEmbedInfo({ daemonUrl: config.daemonUrl, reachable: false, panel: config.panel }))
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
      info = buildEmbedInfo({ daemonUrl: config.daemonUrl, reachable: false, panel: config.panel });
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
 * Stable bridge notice for a lifecycle snapshot.
 * @param {Record<string, unknown> | null | undefined} snapshot
 * @returns {string}
 */
function bridgeReason(snapshot) {
  const reason = snapshot?.reason;
  if (reason === 'managed_cli_missing' || reason === 'managed_start_failed') return reason;
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
    case 'managed_cli_missing':
      return 'mcp bridge unavailable (managed_cli_missing): install Mebular or set MEBULAR_CLI/cliPath, then restart DSH';
    case 'managed_start_failed':
      return 'mcp bridge unavailable (managed_start_failed): the managed daemon did not become healthy; start Mebular manually';
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
  const intervalMs = Number.isFinite(opts.intervalMs) && opts.intervalMs > 0
    ? opts.intervalMs
    : DEFAULT_BRIDGE_POLL_INTERVAL_MS;
  const setIntervalFn = typeof opts.setIntervalFn === 'function' ? opts.setIntervalFn : setInterval;
  const clearIntervalFn = typeof opts.clearIntervalFn === 'function' ? opts.clearIntervalFn : clearInterval;

  /** @type {{ ok: true, dispose: () => Promise<void> } | null} */
  let mounted = null;
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

    const status = snapshot?.status;
    if (status === 'up') {
      lastNotice = null;
      if (mounted !== null) return;
      let result;
      try {
        result = await mount(daemonUrl);
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
          await handle.dispose().catch(() => {});
        }
      });
    return disposal;
  }

  return {
    start,
    check: tick,
    dispose,
    getState: () => ({ mounted: mounted !== null, timer: timer !== null, disposed }),
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
    'probe', 'fetchImpl', 'spawnFn', 'resolveCli', 'exists', 'env', 'home', 'platform',
    'now', 'sleep', 'timeoutMs', 'cacheTtlMs', 'startTimeoutMs', 'pollIntervalMs', 'killGraceMs',
  ]) {
    if (opts[key] !== undefined) lifecycleOptions[key] = opts[key];
  }
  const lifecycle = isObject(opts.lifecycle) && typeof opts.lifecycle.inspect === 'function'
    ? opts.lifecycle
    : createDaemonLifecycle(lifecycleOptions);

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
        const pending = bridge.dispose();
        lifecycle.dispose?.();
        return pending;
      },
      '@mebular/dsh-plugin: daemon lifecycle and MCP bridge',
    );
  }
  const lifecycleStart = Promise.resolve().then(() => lifecycle.start?.());
  lifecycleStart.catch((error) => log('warn', `lifecycle start failed (${safeErrorCode(error)})`));
  void lifecycleStart;
  void bridge.start();

  const handler = createEmbedInfoHandler({ config: resolved, lifecycle });
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
