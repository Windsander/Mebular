// Adapter registry (W1).
//
// Host adapters are data + methods; adding a host means adding a descriptor
// module and one registration line. DSH is implemented in `dsh.mjs`; Hermes is
// still an explicit `pending` placeholder so callers get `ADAPTER_UNAVAILABLE`
// instead of a fake install success.
//
// Reserved follow-up import (uncomment when the host module lands):
//   import { hermesAdapter } from './hermes.mjs';

import { dshAdapter } from './dsh.mjs';
import { openChamberAdapter, openCodeAdapter } from './opencode.mjs';

const registry = new Map();

const MCP_ONLY_HOSTS = [
  { hostId: 'claude-code', displayName: 'Claude Code' },
  { hostId: 'claude-desktop', displayName: 'Claude Desktop' },
  { hostId: 'cursor', displayName: 'Cursor' },
  { hostId: 'generic', displayName: 'Generic MCP client' },
];

/**
 * MCP-only / pending descriptor. Every provisioning call fails with a stable
 * code; nothing is written to the host.
 */
export function createUnsupportedAdapter({
  hostId,
  displayName = hostId,
  status = 'unsupported',
  code = 'ADAPTER_UNSUPPORTED',
  reason = 'mcp_only',
} = {}) {
  const fail = async () => ({ ok: false, code, reason });
  return {
    hostId,
    displayName,
    status,
    reason,
    package: { name: null, version: null, source: 'manual' },
    detect: async () => ({ detected: false, signals: [{ kind: 'unsupported', source: reason, hit: false }] }),
    ensurePackage: fail,
    configure: fail,
    activate: async () => ({ ok: true, activation: 'next-start' }),
    verify: async () => ({ ok: false, code, checks: [] }),
    rollback: async () => ({ ok: true, removed: false, restoredFrom: null }),
  };
}

const DESCRIPTOR_METHODS = ['detect', 'ensurePackage', 'configure', 'activate', 'verify', 'rollback'];

/** Extensible registration (tests / future host modules). */
export function registerAdapter(adapter) {
  if (!adapter || typeof adapter.hostId !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(adapter.hostId)) {
    throw new Error('adapter.hostId must be lower-case kebab-case');
  }
  for (const method of DESCRIPTOR_METHODS) {
    if (typeof adapter[method] !== 'function') throw new Error(`adapter ${adapter.hostId} missing ${method}()`);
  }
  registry.set(adapter.hostId, adapter);
  return adapter;
}

/** Resolve a descriptor, or null for an unknown host. */
export function getAdapter(hostId) {
  return registry.get(hostId) ?? null;
}

export function listAdapters() {
  return [...registry.values()];
}

export const ADAPTER_HOST_IDS = Object.freeze([
  'opencode',
  'openchamber',
  'dsh',
  'hermes',
  ...MCP_ONLY_HOSTS.map((host) => host.hostId),
]);

registerAdapter(openCodeAdapter);
registerAdapter(openChamberAdapter);
registerAdapter(dshAdapter);

// Hermes arrives in a follow-up session on this branch. Until then the
// placeholder is honest: MCP keeps working, adapter = unavailable.
registerAdapter(createUnsupportedAdapter({
  hostId: 'hermes',
  displayName: 'Hermes',
  status: 'pending',
  code: 'ADAPTER_UNAVAILABLE',
  reason: 'adapter_not_implemented',
}));

for (const host of MCP_ONLY_HOSTS) {
  registerAdapter(createUnsupportedAdapter({
    hostId: host.hostId,
    displayName: host.displayName,
    status: 'unsupported',
    code: 'ADAPTER_UNSUPPORTED',
    reason: 'mcp_only',
  }));
}
