// Desktop startup/upgrade adapter-repair hook (no Electron, no real host I/O).

import { describe, it, expect, jest } from '@jest/globals';
import { repairConnectedAdapters } from '../../apps/desktop/src/main/adapter-repair.mjs';

function modulesWith(list) {
  const ensureAdaptersForConnected = jest.fn(async (options) => ({
    ok: true,
    scope: 'adapter-provisioning',
    hosts: [],
    summary: { total: options.connectedHostIds.length, active: 0, installed: 0, unsupported: 0, degraded: 0 },
  }));
  return {
    modules: {
      clients: {
        assistantUserHome: () => '/fixture/user',
        listAssistantsAsync: async () => ({ assistants: list }),
      },
      provision: { ensureAdaptersForConnected },
    },
    ensureAdaptersForConnected,
  };
}

describe('desktop adapter repair hook', () => {
  it('passes only connected=true host ids to provisioning', async () => {
    const { modules, ensureAdaptersForConnected } = modulesWith([
      { id: 'opencode', connected: true },
      { id: 'cursor', connected: false },
      { id: 'dsh', connected: true },
    ]);
    const result = await repairConnectedAdapters({ modules, home: '/fixture/home', cwd: '/fixture/cwd', resourcesPath: '/fixture/res' });
    expect(result.skipped).toBe(false);
    expect(ensureAdaptersForConnected).toHaveBeenCalledTimes(1);
    expect(ensureAdaptersForConnected.mock.calls[0][0]).toMatchObject({
      home: '/fixture/home',
      connectedHostIds: ['opencode', 'dsh'],
      userHome: '/fixture/user',
      resourcesPath: '/fixture/res',
    });
  });

  it('no connected hosts: no adapter write at all', async () => {
    const { modules, ensureAdaptersForConnected } = modulesWith([{ id: 'opencode', connected: false }]);
    const result = await repairConnectedAdapters({ modules, home: '/fixture/home' });
    expect(result).toMatchObject({ ok: true, skipped: true, reason: 'no_connected_hosts' });
    expect(ensureAdaptersForConnected).not.toHaveBeenCalled();
  });

  it('missing modules / thrown detection never breaks startup', async () => {
    expect(await repairConnectedAdapters({ modules: null })).toMatchObject({
      ok: false,
      skipped: true,
      reason: 'adapter_modules_unavailable',
    });
    const modules = {
      clients: { listAssistantsAsync: async () => { throw new Error('boom'); } },
      provision: { ensureAdaptersForConnected: jest.fn() },
    };
    expect(await repairConnectedAdapters({ modules, home: '/fixture/home' })).toMatchObject({
      ok: false,
      skipped: true,
      reason: 'adapter_repair_failed',
    });
  });
});
