// Adapter provisioning orchestration (W1/W5).
//
// Flow: detect → ensure package (never npm) → configure (idempotent, backup,
// atomic) → activate (injected reload/restart only) → verify (readback) →
// persist `<home>/adapters.json`. Failures roll back the config/package and
// record a stable code; MCP connection success is never affected.

import { homedir } from 'node:os';
import { sep } from 'node:path';
import { getAdapter } from './adapters/index.mjs';
import { loadAdapterState, updateAdapterHost, publicAdapterState } from './adapter-state.mjs';
import { homeDir } from './home.mjs';
import { APP_VERSION } from './version.mjs';

function failure(code, extra = {}) {
  return { ok: false, code, ...extra };
}

function resolveUserHome(options = {}) {
  if (typeof options.userHome === 'string' && options.userHome.length > 0) return options.userHome;
  const env = options.env ?? process.env;
  const fromEnv = env?.MEBULAR_USER_HOME;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  return homedir();
}

function displayPath(path, userHome) {
  if (typeof path !== 'string' || path.length === 0) return null;
  if (typeof userHome === 'string' && userHome.length > 0) {
    const prefix = userHome.endsWith(sep) ? userHome : `${userHome}${sep}`;
    if (path.startsWith(prefix)) return `~${path.slice(userHome.length)}`;
  }
  return path;
}

async function record(hostId, patch, home) {
  try {
    await updateAdapterHost(hostId, patch, { home });
  } catch {
    // State is diagnostic only; never fail provisioning because it could not
    // be written (the config/package result is still authoritative).
  }
}

function unsupportedStatus() {
  return 'unsupported';
}

/**
 * Ensure one host adapter. `options.dryRun` only reports the planned change.
 *
 * Only explicit connect/repair callers should invoke this for a host; the
 * connected-only fan-out lives in `ensureAdaptersForConnected`.
 */
export async function ensureAdapter(hostId, options = {}) {
  const home = options.home ?? homeDir();
  const connected = options.connected === true;
  const dryRun = options.dryRun === true;
  const expectedVersion = options.expectedVersion ?? APP_VERSION;
  const adapter = getAdapter(hostId);
  const previousState = loadAdapterState({ home }).hosts[hostId] ?? null;

  if (!adapter) {
    if (!dryRun) await record(hostId, { detected: false, ...(connected ? { connected: true } : {}), adapter: 'unsupported', lastError: 'ADAPTER_UNAVAILABLE' }, home);
    return failure('ADAPTER_UNAVAILABLE', { hostId });
  }
  if (adapter.status === 'unsupported' || adapter.status === 'pending') {
    const code = adapter.status === 'pending' ? 'ADAPTER_UNAVAILABLE' : 'ADAPTER_UNSUPPORTED';
    if (!dryRun) {
      await record(hostId, {
        detected: false,
        ...(connected ? { connected: true } : {}),
        adapter: unsupportedStatus(adapter),
        lastError: code,
      }, home);
    }
    return failure(code, { hostId, status: 'unsupported', reason: adapter.reason ?? null });
  }

  let detection;
  try {
    detection = await adapter.detect({ ...options, home, expectedVersion });
  } catch {
    if (!dryRun) await record(hostId, { detected: false, ...(connected ? { connected: true } : {}), adapter: 'degraded', lastError: 'DETECT_FAILED' }, home);
    return failure('DETECT_FAILED', { hostId, status: 'degraded' });
  }

  if (detection?.detected !== true && options.force !== true && connected !== true) {
    if (!dryRun) await record(hostId, { detected: false, ...(connected ? { connected: true } : {}), lastError: 'HOST_NOT_DETECTED' }, home);
    return failure('HOST_NOT_DETECTED', { hostId, status: 'absent' });
  }

  const packageInfo = await adapter.ensurePackage({
    ...options,
    home,
    expectedVersion,
    ...(dryRun ? { dryRun: true, stagePackage: false } : {}),
  });
  if (!packageInfo?.ok) {
    if (!dryRun) {
      await record(hostId, {
        detected: detection?.detected === true,
        ...(connected ? { connected: true } : {}),
        adapter: 'degraded',
        lastError: packageInfo?.code ?? 'ADAPTER_PACKAGE_NOT_FOUND',
      }, home);
    }
    return failure(packageInfo?.code ?? 'ADAPTER_PACKAGE_NOT_FOUND', { hostId, status: 'degraded' });
  }

  const configured = await adapter.configure({
    ...options,
    home,
    expectedVersion,
    packageInfo,
    configPath: detection?.configPath ?? options.configPath,
  });
  if (!configured?.ok) {
    if (!dryRun) {
      await record(hostId, {
        detected: detection?.detected === true,
        ...(connected ? { connected: true } : {}),
        adapter: 'degraded',
        version: packageInfo.version,
        source: packageInfo.source,
        configPath: displayPath(detection?.configPath ?? options.configPath, resolveUserHome(options)),
        lastError: configured?.code ?? 'CONFIGURE_FAILED',
      }, home);
    }
    return failure(configured?.code ?? 'CONFIGURE_FAILED', { hostId, status: 'degraded' });
  }

  if (dryRun) {
    return {
      ok: true,
      hostId,
      dryRun: true,
      changed: configured.changed === true,
      status: configured.changed === true ? 'planned' : 'installed',
      activation: 'next-start',
      version: packageInfo.version,
      source: packageInfo.source,
      preview: configured.preview ?? '',
      ingested: null,
    };
  }

  const activation = configured.changed === true
    ? await adapter.activate({ ...options, home, expectedVersion, packageInfo })
    : { ok: true, activation: previousState?.activation ?? 'next-start' };
  if (!activation?.ok) {
    await adapter.rollback({
      ...options,
      home,
      expectedVersion,
      packageInfo,
      removePackage: true,
      backupPath: configured.backupPath ?? null,
      configPath: configured.configPath,
    }).catch(() => null);
    await record(hostId, {
      detected: detection?.detected === true,
      ...(connected ? { connected: true } : {}),
      adapter: 'degraded',
      version: packageInfo.version,
      source: packageInfo.source,
      configPath: displayPath(detection?.configPath ?? options.configPath, resolveUserHome(options)),
      lastError: activation?.code ?? 'ACTIVATION_FAILED',
    }, home);
    return failure(activation?.code ?? 'ACTIVATION_FAILED', { hostId, status: 'degraded' });
  }

  const verified = await adapter.verify({
    ...options,
    home,
    expectedVersion,
    packageInfo,
    configPath: configured.configPath,
  });
  if (!verified?.ok) {
    if (configured.changed === true) {
      await adapter.rollback({
        ...options,
        home,
        expectedVersion,
        packageInfo,
        removePackage: true,
        backupPath: configured.backupPath ?? null,
        configPath: configured.configPath,
      }).catch(() => null);
    }
    await record(hostId, {
      detected: detection?.detected === true,
      ...(connected ? { connected: true } : {}),
      adapter: 'degraded',
      version: packageInfo.version,
      source: packageInfo.source,
      configPath: displayPath(detection?.configPath ?? options.configPath, resolveUserHome(options)),
      lastError: verified?.code ?? 'VERIFY_FAILED',
    }, home);
    return failure(verified?.code ?? 'VERIFY_FAILED', {
      hostId,
      status: 'degraded',
      checks: verified?.checks ?? [],
    });
  }

  const status = activation.activation === 'next-start' ? 'installed' : 'active';
  await record(hostId, {
    detected: detection?.detected === true,
    ...(connected ? { connected: true } : {}),
    adapter: status,
    version: packageInfo.version,
    source: packageInfo.source,
    configPath: displayPath(detection?.configPath ?? options.configPath, resolveUserHome(options)),
    activation: activation.activation,
    lastError: null,
    verifiedAt: Date.now(),
  }, home);

  return {
    ok: true,
    hostId,
    status,
    changed: configured.changed === true,
    activation: activation.activation,
    version: packageInfo.version,
    source: packageInfo.source,
    verified: true,
    ingested: null,
    health: 'deferred',
    checks: verified.checks ?? [],
  };
}

/** Dry-run alias (no writes). */
export async function dryRun(hostId, options = {}) {
  return ensureAdapter(hostId, { ...options, dryRun: true });
}

/** Repair one host; refuses hosts that are not connected. */
export async function repairAdapter(hostId, options = {}) {
  const home = options.home ?? homeDir();
  const state = loadAdapterState({ home });
  const connected = options.connected === true || state.hosts[hostId]?.connected === true;
  if (!connected) return failure('NOT_CONNECTED', { hostId, status: 'absent' });
  return ensureAdapter(hostId, { ...options, mode: 'repair', connected: true });
}

/**
 * Fan-out for App startup/upgrade and `mebular adapter repair`.
 * Exactly one of:
 *   * `connectedHostIds` (live MCP connection detection), or
 *   * state hosts with `connected === true`.
 * Unconnected hosts are never touched.
 */
export async function ensureAdaptersForConnected(options = {}) {
  const home = options.home ?? homeDir();
  const state = loadAdapterState({ home });
  const explicit = Array.isArray(options.connectedHostIds)
    ? [...new Set(options.connectedHostIds.filter((id) => typeof id === 'string' && id.length > 0))]
    : null;
  const ids = explicit ?? Object.entries(state.hosts)
    .filter(([, record]) => record?.connected === true)
    .map(([hostId]) => hostId);

  const hosts = [];
  for (const hostId of ids) {
    if (explicit === null && state.hosts[hostId]?.connected !== true) continue;
    hosts.push(await repairAdapter(hostId, { ...options, home, connected: true }));
  }

  const degraded = hosts.filter((entry) => entry.status === 'degraded' || entry.ok !== true)
    .filter((entry) => !['ADAPTER_UNSUPPORTED', 'ADAPTER_UNAVAILABLE', 'NOT_CONNECTED'].includes(entry.code));
  return {
    ok: degraded.length === 0,
    scope: 'adapter-provisioning',
    hosts,
    summary: {
      total: hosts.length,
      active: hosts.filter((entry) => entry.status === 'active').length,
      installed: hosts.filter((entry) => entry.status === 'installed').length,
      unsupported: hosts.filter((entry) => ['ADAPTER_UNSUPPORTED', 'ADAPTER_UNAVAILABLE', 'NOT_CONNECTED'].includes(entry.code)).length,
      degraded: degraded.length,
    },
  };
}

/** Read-only `adapters.json` view. */
export function adapterStatus(options = {}) {
  return publicAdapterState(options);
}

/** Roll back the host config (and a package staged during this run). */
export async function rollbackAdapter(hostId, options = {}) {
  const home = options.home ?? homeDir();
  const adapter = getAdapter(hostId);
  if (!adapter || adapter.status === 'unsupported' || adapter.status === 'pending') {
    return failure('ADAPTER_UNAVAILABLE', { hostId });
  }
  const result = await adapter.rollback({ ...options, home });
  if (!result?.ok) {
    await record(hostId, { lastError: result?.code ?? 'ROLLBACK_FAILED' }, home);
    return failure(result?.code ?? 'ROLLBACK_FAILED', { hostId });
  }
  await record(hostId, { adapter: 'absent', lastError: null, verifiedAt: Date.now() }, home);
  return {
    ok: true,
    hostId,
    status: 'absent',
    restoredFrom: result.restoredFrom === 'backup' ? 'backup' : null,
    removed: result.removed === true,
  };
}
