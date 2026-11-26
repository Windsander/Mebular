// Adapter health from the existing Memory Runtime sidecar (W1/W7).
//
// The sidecar already knows whether an adapter is really working:
//   * `/status.counts.ingested` — has any ingest landed?
//   * `/traces?limit=…` — did this host produce recall/context evidence?
//
// Discovery lives at `<home>/memory-runtime.json`; the host token is read from
// its `tokenFile` (JSON `{ token }`, or a bare token for older runtimes) and is
// never logged or persisted. `probeAdapterHealth` is strictly read-only and
// fails open: a missing/unreachable/unauthorized sidecar is `deferred`, never a
// false `degraded`.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homeDir } from './home.mjs';

export const HEALTH_AGENT_IDS = Object.freeze({
  opencode: 'opencode',
  // OpenChamber shares the OpenCode plugin (`agentId=opencode`).
  openchamber: 'opencode',
  dsh: 'dsh',
  hermes: 'hermes',
});

export const HEALTH_STATES = Object.freeze(['healthy', 'degraded', 'deferred']);

const DEFAULT_TIMEOUT_MS = 1500;
const DEFAULT_TRACE_LIMIT = 50;
const MAX_TRACE_LIMIT = 100;
const API_PREFIX = '/memory-runtime/v1';

/** Stable host → sidecar `agentId` (OpenChamber reuses the OpenCode plugin). */
export function agentIdForHost(hostId) {
  if (typeof hostId !== 'string' || hostId.length === 0) return null;
  return HEALTH_AGENT_IDS[hostId] ?? hostId;
}

function positiveInt(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(Math.trunc(number), max);
}

function timestamp(value) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : null;
}

function readJson(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Read the sidecar discovery record; null when absent/unreadable. */
export function readRuntimeDiscovery(home = homeDir()) {
  const discovery = readJson(join(home, 'memory-runtime.json'));
  if (!discovery) return null;
  return discovery;
}

/** Runtime base URL with the `/memory-runtime/v1` API prefix, or null. */
export function runtimeBaseUrl(discovery) {
  if (!discovery || typeof discovery !== 'object') return null;
  if (typeof discovery.url === 'string' && discovery.url.length > 0) {
    return discovery.url.replace(/\/+$/, '');
  }
  const host = typeof discovery.host === 'string' && discovery.host.length > 0 ? discovery.host : null;
  const port = positiveInt(discovery.port, 0, 65535);
  if (!host || port === 0) return null;
  return `http://${host}:${port}${API_PREFIX}`;
}

/** Host token from `tokenFile`; supports JSON `{ token }` and bare tokens. */
export function readHostToken(discovery) {
  if (!discovery || typeof discovery.tokenFile !== 'string' || discovery.tokenFile.length === 0) return '';
  let raw;
  try {
    raw = readFileSync(discovery.tokenFile, 'utf-8').trim();
  } catch {
    return '';
  }
  if (raw.length === 0) return '';
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.token === 'string') return parsed.token.trim();
  } catch {
    // Older/raw token file.
  }
  return raw;
}

async function getJson(fetchImpl, url, token, timeoutMs) {
  const headers = { accept: 'application/json' };
  if (token.length > 0) headers.authorization = `Bearer ${token}`;
  const init = { method: 'GET', headers };
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    init.signal = AbortSignal.timeout(timeoutMs);
  }
  try {
    const response = await fetchImpl(url, init);
    if (!response || response.ok === false) return { ok: false };
    let body = null;
    try {
      body = typeof response.json === 'function' ? await response.json() : null;
    } catch {
      body = null;
    }
    if (body && typeof body === 'object' && body.ok === false) return { ok: false };
    const data = body && typeof body === 'object' && body.data !== undefined
      ? body.data
      : body;
    return { ok: true, data };
  } catch {
    return { ok: false };
  }
}

function deferred(code = null, extra = {}) {
  return {
    state: 'deferred',
    code,
    health: 'deferred',
    available: false,
    ingested: null,
    traces: 0,
    lastIngestedAt: null,
    ...extra,
  };
}

/**
 * Probe one host's real adapter health through the sidecar.
 *
 * Returns `{ state, code, available, ingested, traces, lastIngestedAt, agentId }`:
 *   * `healthy`  — a host trace exists at/after `installedAt` and ingest > 0;
 *   * `degraded` — the host produced recall/context evidence but ingest is 0
 *                  (`HEALTH_NO_INGEST`);
 *   * `deferred` — no positive evidence yet, or the sidecar is unavailable
 *                  (`HEALTH_UNAVAILABLE`); never falsely degraded.
 *
 * `options.fetchImpl` injects a fetch implementation for tests; `options.home`
 * selects the Mebular home that owns `memory-runtime.json`.
 */
export async function probeAdapterHealth(hostId, options = {}) {
  const home = options.home ?? homeDir();
  const agentId = agentIdForHost(hostId);
  if (!agentId) return deferred(null, { agentId: null });

  const discovery = readRuntimeDiscovery(home);
  const baseUrl = runtimeBaseUrl(discovery);
  if (!baseUrl) return deferred('HEALTH_UNAVAILABLE', { agentId });

  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch;
  if (typeof fetchImpl !== 'function') return deferred('HEALTH_UNAVAILABLE', { agentId });

  const token = readHostToken(discovery);
  const timeoutMs = positiveInt(options.timeoutMs, DEFAULT_TIMEOUT_MS, 30_000);
  const limit = positiveInt(options.traceLimit, DEFAULT_TRACE_LIMIT, MAX_TRACE_LIMIT);
  const installedAt = timestamp(options.installedAt) ?? 0;

  const status = await getJson(fetchImpl, `${baseUrl}/status`, token, timeoutMs);
  if (!status.ok) return deferred('HEALTH_UNAVAILABLE', { agentId });
  const counts = status.data && typeof status.data === 'object' ? status.data.counts : null;
  const ingested = status.data && typeof status.data === 'object' ? timestamp(counts?.ingested) : null;

  const traces = await getJson(fetchImpl, `${baseUrl}/traces?limit=${limit}`, token, timeoutMs);
  if (!traces.ok) {
    // Status alone cannot attribute evidence to this host; stay deferred.
    return deferred('HEALTH_UNAVAILABLE', { agentId, ingested });
  }
  const list = Array.isArray(traces.data?.traces) ? traces.data.traces : [];
  const hostTraces = list
    .filter((trace) => trace && typeof trace === 'object' && trace.agentId === agentId)
    .map((trace) => ({ at: timestamp(trace.at) }))
    .filter((trace) => trace.at !== null && (installedAt <= 0 || trace.at >= installedAt));
  const latest = hostTraces.reduce((max, trace) => (trace.at > max ? trace.at : max), 0);

  if (hostTraces.length > 0 && ingested !== null && ingested > 0) {
    return {
      state: 'healthy',
      code: null,
      health: 'healthy',
      available: true,
      ingested,
      traces: hostTraces.length,
      lastIngestedAt: latest > 0 ? latest : null,
      agentId,
    };
  }
  if (hostTraces.length > 0 && ingested === 0) {
    return {
      state: 'degraded',
      code: 'HEALTH_NO_INGEST',
      health: 'degraded',
      available: true,
      ingested,
      traces: hostTraces.length,
      lastIngestedAt: null,
      agentId,
    };
  }
  return deferred(null, {
    agentId,
    available: true,
    ingested,
    traces: hostTraces.length,
    lastIngestedAt: null,
  });
}
