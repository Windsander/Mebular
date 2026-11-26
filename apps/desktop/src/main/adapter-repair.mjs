// Desktop startup/upgrade hook: repair adapters for already-connected hosts.
//
// Pure-ish module (no Electron import) so it can be unit tested. The caller
// passes the dynamically loaded MCP modules so packaged/dev layouts resolve
// exactly like the daemon CLI does.

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Load `clients.mjs` + `adapter-provision.mjs` from the daemon source dir. */
export async function loadAdapterModules(srcDir) {
  if (typeof srcDir !== 'string' || srcDir.length === 0) return null;
  try {
    const [clients, provision] = await Promise.all([
      import(pathToFileURL(join(srcDir, 'clients.mjs')).href),
      import(pathToFileURL(join(srcDir, 'adapter-provision.mjs')).href),
    ]);
    return { clients, provision };
  } catch {
    return null;
  }
}

/**
 * Repair adapters for hosts whose MCP connection is live (`connected === true`).
 * Never touches detected-but-unconnected hosts; never throws to the caller.
 */
export async function repairConnectedAdapters({
  modules,
  home,
  cwd = process.cwd(),
  resourcesPath,
  userHome,
} = {}) {
  if (!modules?.clients?.listAssistantsAsync || !modules?.provision?.ensureAdaptersForConnected) {
    return { ok: false, skipped: true, reason: 'adapter_modules_unavailable', hosts: [] };
  }
  try {
    const resolvedUserHome = userHome ?? modules.clients.assistantUserHome?.() ?? undefined;
    const list = await modules.clients.listAssistantsAsync({
      home,
      cwd,
      ...(resolvedUserHome ? { userHome: resolvedUserHome } : {}),
      refresh: true,
      ttlMs: 0,
    });
    const connectedHostIds = (list.assistants ?? [])
      .filter((assistant) => assistant.connected === true)
      .map((assistant) => assistant.id);
    if (connectedHostIds.length === 0) {
      return { ok: true, skipped: true, reason: 'no_connected_hosts', hosts: [] };
    }
    const result = await modules.provision.ensureAdaptersForConnected({
      home,
      cwd,
      ...(resolvedUserHome ? { userHome: resolvedUserHome } : {}),
      connectedHostIds,
      ...(typeof resourcesPath === 'string' && resourcesPath.length > 0 ? { resourcesPath } : {}),
    });
    return { ...result, skipped: false };
  } catch {
    return { ok: false, skipped: true, reason: 'adapter_repair_failed', hosts: [] };
  }
}
