// Adapter state (`<home>/adapters.json`, W1/W6).
//
// Rules:
//   * 0600 file / 0700-ish parent (only when newly created);
//   * atomic write (temp + rename);
//   * corrupted file fails open (empty state, `corrupted: true`);
//   * only whitelisted scalar fields are persisted — never tokens, message
//     bodies, or raw error text.

import { readFileSync } from 'node:fs';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homeDir } from './home.mjs';

export const ADAPTER_STATE_SCHEMA = 1;

const ADAPTER_VALUES = new Set(['absent', 'installed', 'active', 'degraded', 'unsupported']);
const ACTIVATION_VALUES = new Set(['reload', 'restart', 'next-start']);
const SOURCE_VALUES = new Set(['bundled', 'managed-dir', 'manual']);
const HOST_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

export function adapterStatePath(home = homeDir()) {
  return join(home, 'adapters.json');
}

export function emptyAdapterState() {
  return { schema: ADAPTER_STATE_SCHEMA, updatedAt: 0, hosts: {} };
}

function stableErrorCode(value) {
  if (typeof value === 'string' && ERROR_CODE_RE.test(value)) return value;
  if (value !== null && typeof value === 'object' && typeof value.code === 'string' && ERROR_CODE_RE.test(value.code)) {
    return value.code;
  }
  return null;
}

function safeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
}

function safePath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 ? value : null;
}

/** Only whitelisted fields survive; unknown keys are dropped. */
export function sanitizeHostRecord(record) {
  const input = record !== null && typeof record === 'object' && !Array.isArray(record) ? record : {};
  const out = {};
  if (typeof input.detected === 'boolean') out.detected = input.detected;
  if (typeof input.connected === 'boolean') out.connected = input.connected;
  if (ADAPTER_VALUES.has(input.adapter)) out.adapter = input.adapter;
  if (typeof input.version === 'string' && input.version.length <= 64) out.version = input.version;
  if (SOURCE_VALUES.has(input.source)) out.source = input.source;
  const configPath = safePath(input.configPath);
  if (configPath !== null) out.configPath = configPath;
  if (ACTIVATION_VALUES.has(input.activation)) out.activation = input.activation;
  out.lastError = stableErrorCode(input.lastError);
  const verifiedAt = safeNumber(input.verifiedAt);
  if (verifiedAt !== null) out.verifiedAt = verifiedAt;
  const lastIngestedAt = safeNumber(input.lastIngestedAt);
  if (lastIngestedAt !== null) out.lastIngestedAt = lastIngestedAt;
  return out;
}

function sanitizeState(parsed) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const hosts = parsed.hosts;
  if (hosts === null || typeof hosts !== 'object' || Array.isArray(hosts)) return null;
  const outHosts = {};
  for (const [hostId, record] of Object.entries(hosts)) {
    if (!HOST_ID_RE.test(hostId)) continue;
    outHosts[hostId] = sanitizeHostRecord(record);
  }
  return {
    schema: ADAPTER_STATE_SCHEMA,
    updatedAt: safeNumber(parsed.updatedAt) ?? 0,
    hosts: outHosts,
  };
}

/** Fail-open load: missing/corrupt/unknown shape → empty state, never throw. */
export function loadAdapterState(options = {}) {
  const home = options.home ?? homeDir();
  const file = adapterStatePath(home);
  let text;
  try {
    text = readFileSync(file, 'utf-8');
  } catch {
    return { ...emptyAdapterState(), corrupted: false };
  }
  try {
    const parsed = JSON.parse(text);
    const state = sanitizeState(parsed);
    if (state === null) return { ...emptyAdapterState(), corrupted: true };
    return { ...state, corrupted: false };
  } catch {
    return { ...emptyAdapterState(), corrupted: true };
  }
}

/** Atomic save with 0600 permissions. */
export async function saveAdapterState(state, options = {}) {
  const home = options.home ?? homeDir();
  const file = adapterStatePath(home);
  const sanitized = sanitizeState({
    schema: ADAPTER_STATE_SCHEMA,
    updatedAt: Date.now(),
    hosts: state?.hosts ?? {},
  }) ?? { ...emptyAdapterState(), updatedAt: Date.now() };
  const text = `${JSON.stringify(sanitized, null, 2)}\n`;
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(tmp, text, { encoding: 'utf-8', mode: 0o600 });
    try { await chmod(tmp, 0o600); } catch { /* Windows 无 POSIX mode */ }
    await rename(tmp, file);
  } catch (error) {
    try { await rm(tmp, { force: true }); } catch { /* ignore */ }
    throw error;
  }
  return sanitized;
}

/** Merge one host record; timestamps are owned by the caller for determinism. */
export async function updateAdapterHost(hostId, patch, options = {}) {
  if (!HOST_ID_RE.test(hostId)) throw new Error('invalid hostId');
  const home = options.home ?? homeDir();
  const state = loadAdapterState({ home });
  const previous = state.hosts[hostId] ?? {};
  const next = sanitizeHostRecord({ ...previous, ...(patch ?? {}) });
  state.hosts[hostId] = next;
  await saveAdapterState(state, { home });
  return next;
}

export function readAdapterHost(hostId, options = {}) {
  const state = loadAdapterState(options);
  return state.hosts[hostId] ?? null;
}

/** Read-only public view (safe to serialize to stdout). */
export function publicAdapterState(options = {}) {
  const state = loadAdapterState(options);
  return {
    schema: state.schema,
    updatedAt: state.updatedAt,
    hosts: state.hosts,
    ...(state.corrupted ? { corrupted: true } : {}),
  };
}
