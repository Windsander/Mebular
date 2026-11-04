// config-apply：restoreBackup 必须参与共享 config lock。
import { describe, it, expect, afterEach } from '@jest/globals';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyPendingPath,
  readApplyPending,
  runApplySupervisor,
} from '../../packages/mcp/src/config-apply.mjs';
import { acquireConfigFileLock } from '../../packages/mcp/src/config-lock.mjs';

const dirs = [];
const savedTimeout = process.env.MEBULAR_CONFIG_LOCK_TIMEOUT_MS;

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'config-apply-lock-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop(), { recursive: true, force: true });
  if (savedTimeout === undefined) delete process.env.MEBULAR_CONFIG_LOCK_TIMEOUT_MS;
  else process.env.MEBULAR_CONFIG_LOCK_TIMEOUT_MS = savedTimeout;
});

describe('config-apply restoreBackup lock', () => {
  it('锁被占用时写 rollback-failed、保留 pending，解锁后可继续恢复', async () => {
    process.env.MEBULAR_CONFIG_LOCK_TIMEOUT_MS = '100';
    const home = await tempDir();
    const configFile = join(home, 'config.json');
    const backupFile = `${configFile}.bak`;
    await writeFile(configFile, JSON.stringify({ current: true }, null, 2), 'utf-8');
    await writeFile(backupFile, JSON.stringify({ restored: true }, null, 2), 'utf-8');
    const release = await acquireConfigFileLock(configFile);
    expect(release).not.toBeNull();
    try {
      const record = await runApplySupervisor({
        home,
        configFile,
        backupFile,
        oldPid: 1,
        port: 0,
        timeoutMs: 50,
        health: async () => ({ healthy: false, waitedMs: 1 }),
        restart: async () => undefined,
      });
      expect(record).toMatchObject({
        status: 'rollback-failed',
        restored: false,
        restoreError: { code: 'CONFIG_BUSY' },
      });
      expect(JSON.parse(await readFile(configFile, 'utf-8'))).toEqual({ current: true });
      expect(await readApplyPending(home)).toMatchObject({ rollingBack: true });
    } finally {
      await release();
    }

    const recovered = await runApplySupervisor({
      home,
      configFile,
      backupFile,
      oldPid: 1,
      port: 0,
      timeoutMs: 50,
      health: async () => ({ healthy: false, waitedMs: 1 }),
      restart: async () => undefined,
    });
    expect(recovered).toMatchObject({ status: 'rollback-failed', restored: true });
    expect(JSON.parse(await readFile(configFile, 'utf-8'))).toEqual({ restored: true });
    expect(await readApplyPending(home)).toBeNull();
    await expect(readFile(applyPendingPath(home), 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
  }, 15000);
});
