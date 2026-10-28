// F-IDENT-1 unit tests: typed identity read/prepare, bootstrap precedence,
// fresh-store guard, and legacy config cleanup. No core runtime is initialized.

import { describe, it, expect, afterEach } from '@jest/globals';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertFreshStore,
  cleanLegacyConfig,
  identityPathFor,
  prepareHomeIdentity,
  prepareIdentity,
  readIdentityFile,
  storagePathForHome,
} from '../../packages/mcp/src/home-identity.mjs';

const tempDirs = [];

async function makeHome() {
  const home = await mkdtemp(join(tmpdir(), 'mebular-home-identity-'));
  tempDirs.push(home);
  await mkdir(home, { recursive: true });
  return home;
}

const HEX = 'a'.repeat(64);

function identityRecord(overrides = {}) {
  return {
    deviceId: 'device-real',
    deviceName: 'real-name',
    publicKeyHex: HEX,
    certificate: {
      deviceId: 'device-real',
      devicePublicKey: HEX,
      createdAt: 1,
      metadata: { name: 'real-name' },
      signature: 'c2lnbmF0dXJl',
    },
    createdAt: 1,
    privateKeyPkcs8: 'cGtjczg=',
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('readIdentityFile', () => {
  it('missing / corrupt / structurally invalid are typed, never thrown', async () => {
    const home = await makeHome();
    const storage = join(home, 'store.jsonl');
    expect(readIdentityFile(storage)).toMatchObject({ status: 'missing', path: identityPathFor(storage) });

    await writeFile(identityPathFor(storage), '{ broken', 'utf-8');
    expect(readIdentityFile(storage).status).toBe('invalid');

    await writeFile(identityPathFor(storage), JSON.stringify({ deviceId: 'device-real' }), 'utf-8');
    const invalid = readIdentityFile(storage);
    expect(invalid.status).toBe('invalid');
    expect(invalid.problems.join('；')).toContain('publicKeyHex');
    expect(invalid.problems.join('；')).toContain('证书');
  });

  it('certificate/device drift and missing private material are invalid', async () => {
    const home = await makeHome();
    const storage = join(home, 'store.jsonl');
    const path = identityPathFor(storage);

    await writeFile(path, JSON.stringify(identityRecord({
      certificate: { ...identityRecord().certificate, deviceId: 'device-other' },
    })), 'utf-8');
    expect(readIdentityFile(storage).problems.join('；')).toContain('证书 deviceId');

    await writeFile(path, JSON.stringify(identityRecord({
      certificate: { ...identityRecord().certificate, devicePublicKey: 'b'.repeat(64) },
    })), 'utf-8');
    expect(readIdentityFile(storage).problems.join('；')).toContain('证书公钥');

    const { privateKeyPkcs8: _omit, ...noKey } = identityRecord();
    await writeFile(path, JSON.stringify(noKey), 'utf-8');
    expect(readIdentityFile(storage).problems.join('；')).toContain('私钥材料');
  });

  it('valid identity returns deviceId/deviceName (deviceName falls back to deviceId)', async () => {
    const home = await makeHome();
    const storage = join(home, 'store.jsonl');
    await writeFile(identityPathFor(storage), JSON.stringify(identityRecord()), 'utf-8');
    const read = readIdentityFile(storage);
    expect(read).toMatchObject({ status: 'valid', deviceId: 'device-real', deviceName: 'real-name' });

    await writeFile(identityPathFor(storage), JSON.stringify(identityRecord({ deviceName: undefined })), 'utf-8');
    expect(readIdentityFile(storage).deviceName).toBe('device-real');
  });
});

describe('prepareIdentity', () => {
  it('valid identity wins over env and legacy config; reports warnings', async () => {
    const home = await makeHome();
    const storagePath = join(home, 'store.jsonl');
    await writeFile(identityPathFor(storagePath), JSON.stringify(identityRecord()), 'utf-8');

    const prepared = prepareIdentity({
      storagePath,
      config: { deviceId: 'device-legacy', deviceName: 'legacy' },
      env: { MEBULAR_DEVICE_ID: 'device-env', MEBULAR_DEVICE_NAME: 'env-name' },
    });

    expect(prepared).toMatchObject({
      ok: true,
      status: 'valid',
      source: 'identity',
      identity: { deviceId: 'device-real', deviceName: 'real-name' },
    });
    expect(prepared.legacyConfigFields).toEqual(['deviceId', 'deviceName']);
    expect(prepared.warnings.join('\n')).toContain('MEBULAR_DEVICE_ID');
    expect(prepared.warnings.join('\n')).toContain('MEBULAR_DEVICE_NAME');
    expect(prepared.warnings.join('\n')).toContain('legacy config.deviceId');
  });

  it('explicit --device-id conflict is IDENTITY_MISMATCH', async () => {
    const home = await makeHome();
    const storagePath = join(home, 'store.jsonl');
    await writeFile(identityPathFor(storagePath), JSON.stringify(identityRecord()), 'utf-8');

    const prepared = prepareIdentity({
      storagePath,
      explicit: { deviceId: 'device-other' },
    });
    expect(prepared).toMatchObject({ ok: false, status: 'mismatch', code: 'IDENTITY_MISMATCH' });
  });

  it('missing identity bootstraps explicit > env > legacy config > default', async () => {
    const home = await makeHome();
    const storagePath = join(home, 'store.jsonl');

    expect(prepareIdentity({ storagePath, explicit: { deviceId: 'device-explicit', deviceName: 'explicit' } }))
      .toMatchObject({ status: 'missing', identity: { deviceId: 'device-explicit', deviceName: 'explicit' } });
    expect(prepareIdentity({ storagePath, env: { MEBULAR_DEVICE_ID: 'device-env', MEBULAR_DEVICE_NAME: 'env' } }))
      .toMatchObject({ status: 'missing', identity: { deviceId: 'device-env', deviceName: 'env' } });
    expect(prepareIdentity({ storagePath, config: { deviceId: 'device-config', deviceName: 'cfg' } }))
      .toMatchObject({ status: 'missing', identity: { deviceId: 'device-config', deviceName: 'cfg' } });
    expect(prepareIdentity({ storagePath }).identity.deviceId).toMatch(/^device-/);
  });

  it('invalid identity is fail closed and never returns a bootstrap value', async () => {
    const home = await makeHome();
    const storagePath = join(home, 'store.jsonl');
    await writeFile(identityPathFor(storagePath), '{"deviceId":"broken"}', 'utf-8');
    expect(prepareIdentity({ storagePath })).toMatchObject({ ok: false, status: 'invalid', code: 'IDENTITY_INVALID' });
  });
});

describe('storagePathForHome', () => {
  it('env > config > home default (sqlite aware)', () => {
    expect(storagePathForHome('/h', { storagePath: '/c/store.jsonl' }, { MEBULAR_STORAGE_PATH: '/e/store.jsonl' }))
      .toBe('/e/store.jsonl');
    expect(storagePathForHome('/h', { storagePath: '/c/store.jsonl' }, {})).toBe('/c/store.jsonl');
    expect(storagePathForHome('/h', { storageAdapter: 'sqlite' }, {})).toBe(join('/h', 'store.sqlite'));
    expect(storagePathForHome('/h', {}, {})).toBe(join('/h', 'store.jsonl'));
  });
});

describe('assertFreshStore', () => {
  it('missing/empty/whitespace-only are fresh; events and sqlite bytes are refused', async () => {
    const home = await makeHome();
    const jsonl = join(home, 'store.jsonl');
    expect(() => assertFreshStore(jsonl)).not.toThrow();

    await writeFile(jsonl, '', 'utf-8');
    expect(() => assertFreshStore(jsonl)).not.toThrow();

    await writeFile(jsonl, '\n  \n\n', 'utf-8');
    expect(() => assertFreshStore(jsonl)).not.toThrow();

    await writeFile(jsonl, '{"id":"e1"}\n', 'utf-8');
    expect(() => assertFreshStore(jsonl)).toThrow(/IDENTITY_STORE_OCCUPIED|拒绝自动生成新身份/);

    const sqlite = join(home, 'store.sqlite');
    await writeFile(sqlite, Buffer.from('SQLite format 3\0'));
    expect(() => assertFreshStore(sqlite)).toThrow(/拒绝自动生成新身份/);
  });

  it('prepareHomeIdentity reports occupied with a typed code', async () => {
    const home = await makeHome();
    await writeFile(join(home, 'store.jsonl'), '{"id":"e1"}\n', 'utf-8');
    const prepared = prepareHomeIdentity({ home, config: {}, env: {} });
    expect(prepared).toMatchObject({ ok: false, status: 'occupied', code: 'IDENTITY_STORE_OCCUPIED' });
  });
});

describe('cleanLegacyConfig', () => {
  it('backs up once, removes identity fields atomically, and is idempotent', async () => {
    const home = await makeHome();
    const cfg = join(home, 'config.json');
    await writeFile(cfg, JSON.stringify({ deviceId: 'device-legacy', deviceName: 'legacy', network: { enabled: false } }), 'utf-8');

    const first = await cleanLegacyConfig({ configPath: cfg, identity: { deviceId: 'device-real' } });
    expect(first.migrated).toBe(true);
    expect(first.backupPath).toBe(`${cfg}.identity-legacy.bak`);
    const cleaned = JSON.parse(await readFile(cfg, 'utf-8'));
    expect(cleaned).not.toHaveProperty('deviceId');
    expect(cleaned).not.toHaveProperty('deviceName');
    expect(cleaned.network).toEqual({ enabled: false });
    expect(JSON.parse(await readFile(first.backupPath, 'utf-8'))).toMatchObject({ deviceId: 'device-legacy' });

    const second = await cleanLegacyConfig({ configPath: cfg });
    expect(second).toMatchObject({ migrated: false, backupPath: null });

    // 再次出现旧字段：迁移继续，但保留最早的 legacy 备份。
    await writeFile(cfg, JSON.stringify({ deviceId: 'device-later' }), 'utf-8');
    await cleanLegacyConfig({ configPath: cfg });
    expect(JSON.parse(await readFile(first.backupPath, 'utf-8')).deviceId).toBe('device-legacy');
    expect(existsSync(cfg)).toBe(true);
  });

  it('missing config is a no-op; corrupt config throws CONFIG_INVALID', async () => {
    const home = await makeHome();
    expect(await cleanLegacyConfig({ configPath: join(home, 'config.json') }))
      .toMatchObject({ migrated: false, backupPath: null });

    const cfg = join(home, 'config.json');
    await writeFile(cfg, '{ broken', 'utf-8');
    await expect(cleanLegacyConfig({ configPath: cfg })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });
});
