// F-IDENT-1：createMebular 运行时身份契约。
// 身份文件是唯一权威；legacy config 自愈；缺失/无效/缺主密钥均 fail closed。

import { describe, it, expect, afterEach, beforeEach } from '@jest/globals';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IdentityManager } from '@mebular/core';
import { createMebular } from '../../packages/mcp/src/config.mjs';
import { createIdentity } from '../../packages/mcp/src/identity.mjs';

const tempDirs = [];
const savedEnv = {};

async function makeHome() {
  const home = await mkdtemp(join(tmpdir(), 'mebular-identity-contract-'));
  tempDirs.push(home);
  await mkdir(home, { recursive: true });
  savedEnv.MEBULAR_HOME = process.env.MEBULAR_HOME;
  process.env.MEBULAR_HOME = home;
  process.env.MEBULAR_NETWORK_ENABLED = '0';
  delete process.env.MEBULAR_STORAGE_PATH;
  delete process.env.MEBULAR_DEVICE_ID;
  delete process.env.MEBULAR_DEVICE_NAME;
  delete process.env.MEBULAR_PROVISION;
  return home;
}

async function seedMaster(home) {
  const manager = new IdentityManager();
  const master = await manager.generateUserMasterKey();
  await writeFile(join(home, 'user-master-key.json'), JSON.stringify({
    publicKey: Buffer.from(master.publicKey).toString('base64'),
    privateKeyPkcs8: await IdentityManager.exportPrivateKey(master.privateKey),
  }, null, 2), 'utf-8');
  return master;
}

async function seedIdentity(home, master, { deviceId = 'device-real', deviceName = 'real-name' } = {}) {
  return createIdentity({
    storagePath: join(home, 'store.jsonl'),
    deviceId,
    deviceName,
    userMasterPrivateKey: master.privateKey,
    userMasterPublicKey: master.publicKey,
  });
}

async function seedConfig(home, extra = {}) {
  await writeFile(join(home, 'config.json'), JSON.stringify({
    storagePath: join(home, 'store.jsonl'),
    network: { enabled: false },
    sync: { autoSync: false },
    ...extra,
  }, null, 2), 'utf-8');
}

beforeEach(async () => {
  await makeHome();
});

afterEach(async () => {
  if (savedEnv.MEBULAR_HOME === undefined) delete process.env.MEBULAR_HOME;
  else process.env.MEBULAR_HOME = savedEnv.MEBULAR_HOME;
  delete process.env.MEBULAR_NETWORK_ENABLED;
  delete process.env.MEBULAR_DEVICE_ID;
  delete process.env.MEBULAR_DEVICE_NAME;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('createMebular identity contract', () => {
  it('valid identity + legacy config mismatch self-heals with backup', async () => {
    const home = process.env.MEBULAR_HOME;
    const master = await seedMaster(home);
    await seedIdentity(home, master, { deviceId: 'device-real', deviceName: 'real-name' });
    await seedConfig(home, { deviceId: 'device-legacy', deviceName: 'legacy-name' });

    const { app } = await createMebular();
    try {
      expect(app.deviceId).toBe('device-real');
    } finally {
      await app.shutdown();
    }
    const config = JSON.parse(await readFile(join(home, 'config.json'), 'utf-8'));
    expect(config).not.toHaveProperty('deviceId');
    expect(config).not.toHaveProperty('deviceName');
    const backup = JSON.parse(await readFile(join(home, 'config.json.identity-legacy.bak'), 'utf-8'));
    expect(backup).toMatchObject({ deviceId: 'device-legacy', deviceName: 'legacy-name' });
  });

  it('env device id/name are ignored when a valid identity exists', async () => {
    const home = process.env.MEBULAR_HOME;
    const master = await seedMaster(home);
    await seedIdentity(home, master, { deviceId: 'device-real', deviceName: 'real-name' });
    await seedConfig(home);
    process.env.MEBULAR_DEVICE_ID = 'device-env-other';
    process.env.MEBULAR_DEVICE_NAME = 'env-other';

    const { app, deviceId, effective } = await createMebular();
    try {
      expect(deviceId).toBe('device-real');
      expect(effective.deviceName).toBe('real-name');
    } finally {
      await app.shutdown();
    }
    expect((await readFile(join(home, 'store.jsonl.identity.json'), 'utf-8'))).toContain('device-real');
  });

  it('invalid identity fails closed without touching config', async () => {
    const home = process.env.MEBULAR_HOME;
    await writeFile(join(home, 'store.jsonl.identity.json'), '{"deviceId":"broken"}\n', 'utf-8');
    await seedConfig(home);
    const before = await readFile(join(home, 'config.json'), 'utf-8');

    await expect(createMebular()).rejects.toMatchObject({ code: 'IDENTITY_INVALID' });
    expect(await readFile(join(home, 'config.json'), 'utf-8')).toBe(before);
  });

  it('missing identity with existing store fails closed (no auto rekey)', async () => {
    const home = process.env.MEBULAR_HOME;
    await seedMaster(home);
    await seedConfig(home);
    await writeFile(join(home, 'store.jsonl'), '{"id":"e1"}\n', 'utf-8');

    await expect(createMebular()).rejects.toMatchObject({ code: 'IDENTITY_STORE_OCCUPIED' });
    expect(existsSync(join(home, 'store.jsonl.identity.json'))).toBe(false);
  });

  it('existing identity + missing user master key fails closed (never generates a new trust root)', async () => {
    const home = process.env.MEBULAR_HOME;
    const master = await seedMaster(home);
    await seedIdentity(home, master);
    await seedConfig(home);
    await rm(join(home, 'user-master-key.json'), { force: true });

    await expect(createMebular()).rejects.toMatchObject({ code: 'IDENTITY_TRUST_ROOT_MISSING' });
    expect(existsSync(join(home, 'user-master-key.json'))).toBe(false);
  });
});
