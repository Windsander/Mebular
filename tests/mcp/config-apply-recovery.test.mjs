// config-apply：生产启动/下次 apply 对 rollingBack pending 的有界自动恢复。
import { describe, it, expect, afterEach } from '@jest/globals';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readApplyPending,
  readApplyResult,
  recoverPendingRollback,
  writeApplyPending,
} from '../../packages/mcp/src/config-apply.mjs';
import { buildSettings } from '../../packages/mcp/src/admin.mjs';

const dirs = [];

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'config-apply-recovery-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop(), { recursive: true, force: true });
});

const hashOf = (text) => createHash('sha256').update(text).digest('hex');

async function seed(home, overrides = {}) {
  const configFile = join(home, 'config.json');
  const backupFile = `${configFile}.bak`;
  const currentConfig = JSON.stringify({ current: true }, null, 2);
  await writeFile(configFile, currentConfig, 'utf-8');
  await writeFile(backupFile, JSON.stringify({ restored: true }, null, 2), 'utf-8');
  await writeApplyPending(home, {
    attempt: 7,
    applyId: 'apply-7',
    at: new Date().toISOString(),
    fields: ['joinService.port'],
    attempts: 1,
    rollingBack: true,
    reason: '新实例在 50ms 内未健康',
    failedConfigHash: hashOf(currentConfig),
    ...overrides,
  });
  return { configFile, backupFile, currentConfig };
}

const fakeApp = {
  deviceId: 'device-fake',
  semanticVectorIndex: null,
  getNamespaceDeclarations: async () => [],
  getBlockedDevices: async () => [],
  getDeviceNames: async () => ({}),
};
const fakeService = {
  status: async () => ({
    running: false,
    pendingEventCount: 0,
    deviceId: 'device-fake',
    peerId: null,
    listenAddrs: [],
    relays: [],
  }),
};

describe('config-apply rollingBack 恢复', () => {
  it('成功：还原备份、写 rolled-back 并清除 pending', async () => {
    const home = await tempDir();
    const { configFile, backupFile } = await seed(home);

    const record = await recoverPendingRollback({ home, configFile, backupFile });

    expect(record).toMatchObject({
      status: 'rolled-back',
      restored: true,
      recovered: true,
      attempt: 7,
      backup: backupFile,
    });
    expect(JSON.parse(await readFile(configFile, 'utf-8'))).toEqual({ restored: true });
    expect(await readApplyPending(home)).toBeNull();
    expect(await readApplyResult(home)).toMatchObject({ status: 'rolled-back', restored: true, attempt: 7 });
  }, 10000);

  it('失败：保留 pending，写 rollback-failed 且 admin lastApply 不再被 in-progress 掩盖', async () => {
    const home = await tempDir();
    const { configFile, backupFile } = await seed(home);
    await rm(backupFile, { force: true });

    const record = await recoverPendingRollback({ home, configFile, backupFile });

    expect(record).toMatchObject({
      status: 'rollback-failed',
      restored: false,
      recovered: false,
      attempt: 7,
      restoreError: { code: 'BACKUP_MISSING' },
    });
    expect(JSON.parse(await readFile(configFile, 'utf-8'))).toEqual({ current: true });
    expect(await readApplyPending(home)).toMatchObject({ rollingBack: true, attempt: 7 });
    expect(await readApplyResult(home)).toMatchObject({ status: 'rollback-failed', restored: false });

    const settings = await buildSettings({
      app: fakeApp,
      service: fakeService,
      config: {},
      runtime: {},
      home,
    });
    expect(settings.lastApply).toMatchObject({ status: 'rollback-failed', restored: false, attempt: 7 });
  }, 10000);

  it('当前配置已变化：不恢复 .bak，写 rollback-skipped 并保留新配置', async () => {
    const home = await tempDir();
    const { configFile, backupFile } = await seed(home);
    const newConfig = JSON.stringify({ legitimately: 'changed' }, null, 2);
    await writeFile(configFile, newConfig, 'utf-8');

    const record = await recoverPendingRollback({ home, configFile, backupFile });

    expect(record).toMatchObject({
      status: 'rollback-skipped',
      skipReason: 'config_changed',
      configChanged: true,
      restored: false,
      attempt: 7,
    });
    expect(await readFile(configFile, 'utf-8')).toBe(newConfig);
    expect(await readApplyPending(home)).toBeNull();
    expect(await readApplyResult(home)).toMatchObject({ status: 'rollback-skipped', skipReason: 'config_changed' });
  }, 10000);

  it('缺少失败配置指纹：拒绝覆盖当前配置并显式跳过', async () => {
    const home = await tempDir();
    const { configFile, backupFile, currentConfig } = await seed(home, { failedConfigHash: undefined });

    const record = await recoverPendingRollback({ home, configFile, backupFile });

    expect(record).toMatchObject({
      status: 'rollback-skipped',
      skipReason: 'missing_config_hash',
      restored: false,
    });
    expect(await readFile(configFile, 'utf-8')).toBe(currentConfig);
    expect(await readApplyPending(home)).toBeNull();
  }, 10000);

  for (const variant of [
    { label: 'null attempt', oldAttempt: null, newAttempt: null },
    { label: 'reused attempt', oldAttempt: 1, newAttempt: 1 },
  ]) {
    it(`恢复期间写入新 pending（${variant.label}）不得误清`, async () => {
      const home = await tempDir();
      const { configFile, backupFile } = await seed(home, {
        attempt: variant.oldAttempt,
        applyId: 'old-apply',
        at: 'old-at',
        fields: ['old.field'],
      });
      const nextPending = {
        attempt: variant.newAttempt,
        applyId: 'new-apply',
        at: 'new-at',
        fields: ['new.field'],
        attempts: 1,
        rollingBack: true,
        reason: '新的失败 apply',
      };

      const record = await recoverPendingRollback({
        home,
        configFile,
        backupFile,
        restoreImpl: async () => {
          await writeApplyPending(home, nextPending);
          return true;
        },
      });

      expect(record).toMatchObject({ status: 'rolled-back', restored: true });
      expect(await readApplyPending(home)).toMatchObject(nextPending);
    }, 10000);
  }
});
