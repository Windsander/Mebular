// fleet-runner.js - public OpenChamber/OpenCode plugin that exposes a
// loopback "run once in a fresh session" endpoint for Mebular Fleet.
//
// Boundary:
//   * disabled by default: only `fleetRunner.enabled === true` starts a server;
//   * loopback only, random port, random bearer token written to a 0600
//     discovery file under `$MEBULAR_HOME` (default `~/.mebular`);
//   * every request creates a NEW session. A client-supplied `sessionId` is
//     rejected: Fleet tasks are one fresh session each;
//   * no private bridge/skill is imported; only Node built-ins and the host
//     `client.session.*` API are used;
//   * the token never appears in logs, HTTP responses, health output or the
//     host capability surface.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import http from 'node:http';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

export const RUNNER_SCHEMA = 1;
export const RUNNER_KIND = 'mebular-openchamber-runner';
export const DISCOVERY_FILE_NAME = 'openchamber-runner.json';
export const DISCOVERY_STALE_MS = 15_000;
export const DISCOVERY_HEARTBEAT_MS = 5_000;
export const MAX_BODY_BYTES = 256 * 1024;
export const MAX_PROMPT_BYTES = 64 * 1024;
export const MAX_TIMEOUT_SEC = 600;
export const DEFAULT_REQUEST_TIMEOUT_MS = 600_000;
export const DEFAULT_HOST = '127.0.0.1';
export const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', 'localhost', '::1']);

const RUNNER_CONFIG_FILE_NAME = 'opencode-plugin.json';
const CONFIG_KEYS = ['enabled', 'discoveryFile', 'port', 'host', 'requestTimeoutMs'];
const RUNNER_VERSION = readPackageVersion();

function readPackageVersion() {
  try {
    const parsed = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
    return typeof parsed.version === 'string' && parsed.version.length > 0 ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.includes(host);
}

/** Resolve `$MEBULAR_HOME` (default `~/.mebular`) without touching Mebular core config. */
export function resolveRunnerHome(options = {}) {
  const env = isObject(options.env) ? options.env : process.env;
  const explicit = asText(options.homeDir);
  if (explicit) return resolve(explicit);
  const envHome = asText(env.MEBULAR_HOME);
  if (envHome) return resolve(envHome);
  const runtimeHome = asText(env.MEBULAR_MEMORY_RUNTIME_HOME);
  if (runtimeHome) {
    const resolved = resolve(runtimeHome);
    if (basename(resolved) === 'memory-runtime') return dirname(resolved);
  }
  return join(homedir(), '.mebular');
}

function readConfigJson(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function runnerSection(source) {
  if (!isObject(source)) return null;
  if (isObject(source.fleetRunner)) return source.fleetRunner;
  if (isObject(source['fleet-runner'])) return source['fleet-runner'];
  return null;
}

function hasRunnerKeys(source) {
  return isObject(source) && CONFIG_KEYS.some((key) => Object.prototype.hasOwnProperty.call(source, key));
}

function positiveInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max) return value;
  return fallback;
}

/**
 * Resolve the `fleetRunner` plugin config.
 *
 * Precedence: explicit plugin options > `$MEBULAR_OPENCODE_PLUGIN_CONFIG` /
 * `$MEBULAR_HOME/opencode-plugin.json` (`fleetRunner` section or flat keys).
 * The runner is disabled unless `enabled === true`; an absent config never
 * enables it.
 */
export function resolveFleetRunnerConfig(input, options = {}) {
  const env = isObject(options.env) ? options.env : process.env;
  const home = resolveRunnerHome({ homeDir: options.homeDir, env });
  const configFile = asText(options.configFile)
    || asText(env.MEBULAR_OPENCODE_PLUGIN_CONFIG)
    || join(home, RUNNER_CONFIG_FILE_NAME);
  const fileValue = readConfigJson(configFile);
  // A shared plugin config file only enables the runner through its explicit
  // `fleetRunner` section; unrelated top-level flags never turn it on.
  const fromFile = runnerSection(fileValue) ?? {};

  const explicit = isObject(input) ? input : {};
  const fromOptions = isObject(options.runner)
    ? options.runner
    : runnerSection(explicit) ?? (hasRunnerKeys(explicit) ? explicit : {});

  const merged = { ...fromFile, ...fromOptions };
  const rawPort = merged.port;
  const port = positiveInteger(rawPort, 0, { min: 0, max: 65_535 });
  const host = asText(merged.host) || DEFAULT_HOST;
  const requestTimeoutMs = positiveInteger(merged.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, {
    min: 1,
    max: MAX_TIMEOUT_SEC * 1000,
  });
  const discoveryFile = asText(merged.discoveryFile) || join(home, DISCOVERY_FILE_NAME);
  return {
    enabled: merged.enabled === true,
    discoveryFile,
    port,
    host,
    requestTimeoutMs,
    configFile,
    home,
  };
}

/** Liveness check used by the discovery lock; `EPERM` still means alive. */
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/** Read a discovery file without throwing. */
export function readDiscoveryFile(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Decide whether an existing discovery record may be replaced.
 * A live PID always wins; a fresh record with no PID is treated as owned.
 */
export function evaluateDiscovery(existing, options = {}) {
  const now = typeof options.now === 'function' ? options.now() : Date.now();
  const staleMs = positiveInteger(options.staleMs, DISCOVERY_STALE_MS, { min: 1 });
  const alive = typeof options.isAlive === 'function' ? options.isAlive : isProcessAlive;
  if (!isObject(existing)) return { claimable: true, reason: 'missing' };
  const pid = existing.pid;
  if (Number.isInteger(pid) && pid > 0 && alive(pid)) {
    return { claimable: false, reason: 'live_pid' };
  }
  const updatedAt = typeof existing.updatedAt === 'number' ? existing.updatedAt : 0;
  const fresh = updatedAt > 0 && now - updatedAt <= staleMs;
  if (fresh && !(Number.isInteger(pid) && pid > 0)) {
    return { claimable: false, reason: 'fresh_unknown_owner' };
  }
  return { claimable: true, reason: pid > 0 ? 'dead_pid' : 'stale' };
}

function ensurePrivateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try {
    chmodSync(path, 0o700);
  } catch {
    // Best effort on platforms that cannot chmod.
  }
}

function writeAll(fd, text) {
  const buffer = Buffer.from(text, 'utf8');
  let offset = 0;
  while (offset < buffer.length) {
    offset += writeSync(fd, buffer, offset, buffer.length - offset);
  }
}

function atomicWriteDiscovery(path, record) {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  ensurePrivateDirectory(dirname(path));
  try {
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      writeAll(fd, JSON.stringify(record));
    } finally {
      closeSync(fd);
    }
    try {
      chmodSync(tmp, 0o600);
    } catch {
      // Best effort.
    }
    try {
      renameSync(tmp, path);
    } catch (error) {
      // Windows does not replace on rename; retry after removing the target.
      if (error?.code !== 'EEXIST' && error?.code !== 'EPERM') throw error;
      try {
        unlinkSync(path);
      } catch {
        // Ignore a concurrent removal.
      }
      renameSync(tmp, path);
    }
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // Already renamed or never created.
    }
  }
}

/**
 * Atomically claim the discovery file.
 * Returns `{ ok: false, holder }` if another live instance owns it.
 */
export function claimDiscovery(path, record, options = {}) {
  const now = typeof options.now === 'function' ? options.now() : Date.now();
  const staleMs = positiveInteger(options.staleMs, DISCOVERY_STALE_MS, { min: 1 });
  const isAlive = typeof options.isAlive === 'function' ? options.isAlive : isProcessAlive;
  ensurePrivateDirectory(dirname(path));
  let sawExisting = false;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      try {
        writeAll(fd, JSON.stringify(record));
      } finally {
        closeSync(fd);
      }
      try {
        chmodSync(path, 0o600);
      } catch {
        // Best effort.
      }
      return { ok: true, replaced: sawExisting, path };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    sawExisting = true;
    const existing = readDiscoveryFile(path);
    const verdict = evaluateDiscovery(existing, { now, staleMs, isAlive });
    if (!verdict.claimable) return { ok: false, reason: verdict.reason, holder: existing };
    try {
      unlinkSync(path);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return { ok: false, reason: 'claim_race', holder: readDiscoveryFile(path) };
}

/** Delete a discovery file only when it still belongs to this instance. */
export function releaseDiscovery(path, owner, options = {}) {
  const token = asText(owner?.token);
  const pid = Number.isInteger(owner?.pid) ? owner.pid : process.pid;
  if (!token) return false;
  const existing = readDiscoveryFile(path);
  if (!isObject(existing) || existing.token !== token || existing.pid !== pid) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

function tokenMatches(header, token) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const provided = Buffer.from(header.slice('Bearer '.length), 'utf8');
  const expected = Buffer.from(token, 'utf8');
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

function sendJson(res, status, payload) {
  if (res.writableEnded || res.destroyed) return;
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(body);
}

function sendError(res, status, code, message) {
  sendJson(res, status, { ok: false, error: code, message });
}

function unwrap(response) {
  if (response && typeof response === 'object' && !Array.isArray(response) && 'data' in response) {
    if (response.error) {
      const error = response.error;
      throw new Error(typeof error === 'string' ? error : 'host request failed');
    }
    return response.data;
  }
  return response;
}

function sessionIdOf(created) {
  if (typeof created === 'string' && created.length > 0) return created;
  if (!isObject(created)) return null;
  for (const key of ['id', 'sessionId', 'sessionID']) {
    if (typeof created[key] === 'string' && created[key].length > 0) return created[key];
  }
  if (isObject(created.session) && typeof created.session.id === 'string' && created.session.id.length > 0) {
    return created.session.id;
  }
  return null;
}

function splitModel(model) {
  if (typeof model !== 'string' || model.length === 0) return undefined;
  const slash = model.indexOf('/');
  if (slash < 0) return { providerID: model, modelID: model };
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

function textFromMessage(message) {
  if (typeof message === 'string') return message;
  if (!isObject(message)) return '';
  if (typeof message.text === 'string') return message.text;
  const parts = Array.isArray(message.parts) ? message.parts : [];
  return parts
    .filter((part) => isObject(part) && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

function lastAssistantText(messages) {
  const list = Array.isArray(messages)
    ? messages
    : isObject(messages) && Array.isArray(messages.messages)
      ? messages.messages
      : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index];
    if (!isObject(message)) continue;
    const role = isObject(message.info) ? message.info.role : message.role;
    if (typeof role === 'string' && role.toLowerCase() === 'assistant') {
      return textFromMessage(message);
    }
  }
  return '';
}

async function withTimeout(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), Math.max(1, timeoutMs));
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function abortSession(client, sessionId, timeoutMs = 1_000) {
  if (!sessionId || typeof client?.session?.abort !== 'function') return false;
  try {
    await withTimeout(
      Promise.resolve().then(() => client.session.abort({ path: { id: sessionId } })),
      timeoutMs,
    );
    return true;
  } catch {
    return false;
  }
}

function readRequestBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_BODY_BYTES) {
        finish({ tooLarge: true });
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => finish({ tooLarge: false, body: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', () => finish({ tooLarge: false, body: '', error: true }));
  });
}

function parseRunRequest(body) {
  if (!isObject(body)) return { error: 'BAD_REQUEST', message: 'body must be a JSON object' };
  if (Object.prototype.hasOwnProperty.call(body, 'sessionId')) {
    return { error: 'BAD_REQUEST', message: 'new session only: sessionId is not accepted' };
  }
  if (typeof body.prompt !== 'string' || body.prompt.length === 0) {
    return { error: 'BAD_REQUEST', message: 'prompt must be a non-empty string' };
  }
  if (Buffer.byteLength(body.prompt, 'utf8') > MAX_PROMPT_BYTES) {
    return { error: 'PAYLOAD_TOO_LARGE', message: `prompt exceeds ${MAX_PROMPT_BYTES} bytes`, status: 413 };
  }
  for (const key of ['agent', 'model', 'title']) {
    if (body[key] !== undefined && typeof body[key] !== 'string') {
      return { error: 'BAD_REQUEST', message: `${key} must be a string` };
    }
  }
  let timeoutSec;
  if (body.timeoutSec !== undefined) {
    if (!Number.isInteger(body.timeoutSec) || body.timeoutSec <= 0 || body.timeoutSec > MAX_TIMEOUT_SEC) {
      return { error: 'BAD_REQUEST', message: `timeoutSec must be an integer between 1 and ${MAX_TIMEOUT_SEC}` };
    }
    timeoutSec = body.timeoutSec;
  }
  const title = asText(body.title) || 'fleet run';
  if (Buffer.byteLength(title, 'utf8') > 512) {
    return { error: 'BAD_REQUEST', message: 'title is too long' };
  }
  return {
    value: {
      prompt: body.prompt,
      timeoutSec,
      agent: asText(body.agent) || undefined,
      model: asText(body.model) || undefined,
      title,
    },
  };
}

/**
 * Start the loopback runner. Returns a handle with `dispose()`; throws
 * `FLEET_RUNNER_ALREADY_RUNNING` when another live process owns discovery.
 */
export async function startFleetRunner(options = {}) {
  const client = options.client;
  if (!client || !isObject(client.session)) {
    const error = new Error('host session API unavailable');
    error.code = 'FLEET_RUNNER_NO_CLIENT';
    throw error;
  }
  const config = isObject(options.config) ? options.config : {};
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const discoveryFile = asText(config.discoveryFile)
    || asText(options.discoveryFile)
    || join(resolveRunnerHome(options), DISCOVERY_FILE_NAME);
  const host = asText(config.host) || DEFAULT_HOST;
  if (!isLoopbackHost(host)) {
    const error = new Error('fleet runner must bind to a loopback host');
    error.code = 'FLEET_RUNNER_NON_LOOPBACK';
    throw error;
  }
  const port = positiveInteger(config.port, 0, { min: 0, max: 65_535 });
  const requestTimeoutMs = positiveInteger(config.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, {
    min: 1,
    max: MAX_TIMEOUT_SEC * 1000,
  });
  const heartbeatMs = positiveInteger(options.heartbeatMs, DISCOVERY_HEARTBEAT_MS, { min: 1 });
  const token = randomBytes(32).toString('hex');
  const startedAt = now();
  let disposed = false;
  let heartbeatTimer;
  let server;

  const runOnce = async (req, res, request) => {
    let sessionId = null;
    let clientGone = false;
    let finished = false;
    const finish = () => {
      finished = true;
    };
    res.on('close', () => {
      if (!finished && !res.writableEnded) {
        clientGone = true;
        void abortSession(client, sessionId);
      }
    });

    const effectiveTimeoutMs = Math.min(
      request.timeoutSec !== undefined ? request.timeoutSec * 1000 : requestTimeoutMs,
      MAX_TIMEOUT_SEC * 1000,
    );
    const started = now();
    const remaining = () => Math.max(1, started + effectiveTimeoutMs - now());
    const timedOut = () => {
      finish();
      if (!clientGone) sendError(res, 504, 'TIMEOUT', `run exceeded ${effectiveTimeoutMs}ms`);
    };

    const createCall = Promise.resolve()
      .then(() => client.session.create({ body: { title: request.title } }))
      .then(
        (value) => ({ value }),
        () => ({ failed: true }),
      );
    const createdOutcome = await withTimeout(createCall, remaining());
    if (createdOutcome.timedOut) {
      // Bound the whole run, including session creation. If the host creates
      // the session after we gave up, abort it best-effort.
      void createCall.then((late) => {
        try {
          const lateId = late.value ? sessionIdOf(unwrap(late.value)) : null;
          if (lateId) void abortSession(client, lateId);
        } catch {
          // Ignore a late malformed response.
        }
      });
      timedOut();
      return;
    }
    if (createdOutcome.failed) {
      finish();
      if (!clientGone) sendError(res, 502, 'SESSION_CREATE_FAILED', 'could not create a new session');
      return;
    }
    let created;
    try {
      created = unwrap(createdOutcome.value);
    } catch {
      finish();
      if (!clientGone) sendError(res, 502, 'SESSION_CREATE_FAILED', 'host returned an invalid session');
      return;
    }
    sessionId = sessionIdOf(created);
    if (!sessionId) {
      finish();
      if (!clientGone) sendError(res, 502, 'SESSION_CREATE_FAILED', 'host returned no session id');
      return;
    }
    if (clientGone) {
      finish();
      await abortSession(client, sessionId);
      return;
    }

    const promptBody = { parts: [{ type: 'text', text: request.prompt }] };
    if (request.agent !== undefined) promptBody.agent = request.agent;
    if (request.model !== undefined) promptBody.model = splitModel(request.model);
    const promptCall = Promise.resolve()
      .then(() => client.session.prompt({ path: { id: sessionId }, body: promptBody }))
      .then(
        (value) => ({ value }),
        () => ({ failed: true }),
      );

    const outcome = await withTimeout(promptCall, remaining());
    if (outcome && outcome.timedOut) {
      await abortSession(client, sessionId);
      timedOut();
      return;
    }
    if (clientGone) {
      await abortSession(client, sessionId);
      finish();
      return;
    }
    if (outcome.failed) {
      finish();
      sendError(res, 502, 'PROMPT_FAILED', 'host prompt failed');
      return;
    }

    let text = '';
    try {
      text = textFromMessage(unwrap(outcome.value));
    } catch {
      text = '';
    }
    if (text.length === 0 && typeof client.session.messages === 'function') {
      try {
        const messages = await withTimeout(
          Promise.resolve().then(() =>
            client.session.messages({ path: { id: sessionId }, query: { limit: 50 } }),
          ),
          Math.max(1, Math.min(5_000, remaining())),
        );
        text = messages && messages.timedOut ? '' : lastAssistantText(unwrap(messages));
      } catch {
        text = '';
      }
    }
    if (clientGone) {
      finish();
      return;
    }
    finish();
    sendJson(res, 200, {
      ok: true,
      result: {
        sessionId,
        text,
        ms: Math.max(0, now() - started),
      },
    });
  };

  const handleRequest = async (req, res) => {
    let pathname = '/';
    try {
      pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    } catch {
      sendError(res, 400, 'BAD_REQUEST', 'invalid request path');
      return;
    }

    if (req.method === 'GET' && pathname === '/health') {
      sendJson(res, 200, { ok: true, version: RUNNER_VERSION, pid: process.pid, startedAt });
      return;
    }
    if (pathname !== '/v1/run-once') {
      sendError(res, 404, 'NOT_FOUND', 'not found');
      return;
    }
    if (req.method !== 'POST') {
      sendError(res, 405, 'METHOD_NOT_ALLOWED', 'use POST');
      return;
    }
    if (!tokenMatches(req.headers.authorization, token)) {
      sendError(res, 401, 'UNAUTHORIZED', 'unauthorized');
      req.resume();
      return;
    }

    const bodyResult = await readRequestBody(req);
    if (bodyResult.tooLarge) {
      sendError(res, 413, 'PAYLOAD_TOO_LARGE', `body exceeds ${MAX_BODY_BYTES} bytes`);
      req.resume();
      return;
    }
    if (bodyResult.error) {
      sendError(res, 400, 'BAD_REQUEST', 'request body could not be read');
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(bodyResult.body);
    } catch {
      sendError(res, 400, 'BAD_REQUEST', 'body must be valid JSON');
      return;
    }
    const request = parseRunRequest(parsed);
    if (request.error) {
      sendError(res, request.status ?? 400, request.error, request.message);
      return;
    }
    await runOnce(req, res, request.value);
  };

  server = http.createServer((req, res) => {
    handleRequest(req, res).catch(() => {
      if (!res.writableEnded) sendError(res, 500, 'INTERNAL_ERROR', 'runner failed');
    });
  });
  // A single run may last up to 600s; do not let Node's default request
  // timeout (300s) cut it off.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.timeout = 0;

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, host, () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });

  const address = server.address();
  const actualPort = isObject(address) && typeof address.port === 'number' ? address.port : port;
  const discovery = {
    schema: RUNNER_SCHEMA,
    kind: RUNNER_KIND,
    pid: process.pid,
    port: actualPort,
    host,
    token,
    version: RUNNER_VERSION,
    startedAt,
    updatedAt: now(),
  };

  let claim;
  try {
    claim = claimDiscovery(discoveryFile, discovery, {
      now,
      staleMs: DISCOVERY_STALE_MS,
      isAlive: options.isProcessAlive ?? isProcessAlive,
    });
  } catch (error) {
    await closeServer(server);
    throw error;
  }
  if (!claim.ok) {
    await closeServer(server);
    const error = new Error('another live fleet runner owns discovery');
    error.code = 'FLEET_RUNNER_ALREADY_RUNNING';
    throw error;
  }

  heartbeatTimer = setInterval(() => {
    if (disposed) return;
    const current = readDiscoveryFile(discoveryFile);
    if (!isObject(current) || current.token !== token || current.pid !== process.pid) {
      // Another instance took over; stop advertising without clobbering it.
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
      return;
    }
    const next = { ...discovery, updatedAt: now() };
    try {
      atomicWriteDiscovery(discoveryFile, next);
      discovery.updatedAt = next.updatedAt;
    } catch {
      // A transient write failure is retried on the next tick.
    }
  }, heartbeatMs);
  heartbeatTimer.unref?.();

  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    if (heartbeatTimer !== undefined) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
    await closeServer(server);
    releaseDiscovery(discoveryFile, discovery);
  };

  return {
    server,
    port: actualPort,
    host,
    token,
    version: RUNNER_VERSION,
    discoveryFile,
    discovery,
    dispose,
  };
}

async function closeServer(server) {
  if (!server) return;
  await new Promise((resolveClose) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolveClose();
    };
    try {
      server.close(() => finish());
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
    } catch {
      finish();
    }
    const timer = setTimeout(finish, 1_000);
    timer.unref?.();
  });
}

/**
 * Build a plugin function with injectable dependencies for tests. The default
 * export below is the normal OpenCode/OpenChamber entry point.
 */
export function createFleetRunnerPlugin(overrides = {}) {
  let active = null;
  let status = { enabled: false, running: false, reason: null, port: null };

  const plugin = async (ctx = {}, pluginOptions = {}) => {
    const client = ctx.client ?? overrides.client;
    const directory = ctx.directory ?? overrides.directory;
    const configInput = isObject(ctx.options) && (runnerSection(ctx.options) !== null || hasRunnerKeys(ctx.options))
      ? ctx.options
      : isObject(pluginOptions) && (runnerSection(pluginOptions) !== null || hasRunnerKeys(pluginOptions))
        ? pluginOptions
        : isObject(overrides.config)
          ? overrides.config
          : {};
    const config = resolveFleetRunnerConfig(configInput, {
      env: overrides.env ?? process.env,
      homeDir: overrides.homeDir,
      configFile: overrides.configFile,
    });
    if (!config.enabled) {
      status = { enabled: false, running: false, reason: 'disabled', port: null };
      return {};
    }
    try {
      active = await startFleetRunner({
        client,
        directory,
        config,
        env: overrides.env,
        homeDir: overrides.homeDir,
        now: overrides.now,
        isProcessAlive: overrides.isProcessAlive,
      });
      status = { enabled: true, running: true, reason: null, port: active.port };
    } catch (error) {
      active = null;
      status = {
        enabled: true,
        running: false,
        reason: error?.code ?? 'start_failed',
        port: null,
      };
      return {};
    }
    return {
      dispose: async () => {
        const handle = active;
        active = null;
        status = { enabled: true, running: false, reason: 'disposed', port: null };
        if (handle) await handle.dispose();
      },
    };
  };
  Object.defineProperty(plugin, 'status', {
    enumerable: false,
    value: () => ({ ...status }),
  });
  return plugin;
}

/** Alias kept for parity with other host plugins (`createPlugin`). */
export const createPlugin = createFleetRunnerPlugin;

export default createFleetRunnerPlugin();
