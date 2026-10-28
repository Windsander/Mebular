// `mebular init` identity contract (F-IDENT-1):
//   - identity file is the sole authority for deviceId/deviceName;
//   - config.json never stores deviceId/deviceName;
//   - legacy config fields are backed up and removed (valid identity wins);
//   - explicit --device-id conflict is a hard error;
//   - invalid identity fails closed, and a missing identity over an existing
//     store is refused (no silent rekey).

import { describe, it, expect, afterEach } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IdentityManager } from '@mebular/core';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI = join(ROOT, 'packages/mcp/bin/mebular.mjs');
const tempDirs = [];

async function makeHome() {
  const home = await mkdtemp(join(tmpdir(), 'mebular-cli-init-'));
  tempDirs.push(home);
  await mkdir(home, { recursive: true });
  return home;
}

async function seedKey(home) {
  const manager = new IdentityManager();
  const master = await manager.generateUserMasterKey();
  const record = {
    publicKey: Buffer.from(master.publicKey).toString('base64'),
    privateKeyPkcs8: await IdentityManager.exportPrivateKey(master.privateKey),
    createdAt: new Date().toISOString(),
  };
  await writeFile(join(home, 'user-master-key.json'), JSON.stringify(record, null, 2), 'utf-8');
  return master;
}

async function seedIdentity(home, master, { deviceId = 'device-test-id', deviceName = 'test-name' } = {}) {
  const manager = new IdentityManager();
  if (master) manager.setUserMasterPrivateKey(master.privateKey);
  const identity = await manager.generateDeviceKey(deviceId, deviceName);
  identity.certificate = await manager.issueDeviceCertificate(deviceId);
  const record = {
    deviceId: identity.deviceId,
    deviceName: identity.name,
    publicKeyHex: Buffer.from(identity.publicKey).toString('hex'),
    certificate: identity.certificate,
    ...(identity.certificateChain !== undefined ? { certificateChain: identity.certificateChain } : {}),
    createdAt: identity.createdAt,
    privateKeyPkcs8: await IdentityManager.exportPrivateKey(identity.privateKey),
  };
  await writeFile(join(home, 'store.jsonl.identity.json'), JSON.stringify(record, null, 2), 'utf-8');
  return record;
}

async function seedDelegatedIdentity(home, master, { deviceId = 'device-leaf' } = {}) {
  const manager = new IdentityManager();
  manager.setUserMasterPrivateKey(master.privateKey);
  const issuer = await manager.generateDeviceKey('device-root', 'root');
  issuer.certificate = await manager.issueDeviceCertificate('device-root');
  const leaf = await manager.generateDeviceKey(deviceId, 'leaf-name');
  const leafCertificate = await manager.issueDelegatedDeviceCertificate(deviceId, 'device-root');
  await writeFile(join(home, 'store.jsonl.identity.json'), JSON.stringify({
    deviceId: leaf.deviceId,
    deviceName: leaf.name,
    publicKeyHex: Buffer.from(leaf.publicKey).toString('hex'),
    certificate: leafCertificate,
    certificateChain: leaf.certificateChain,
    createdAt: leaf.createdAt,
    privateKeyPkcs8: await IdentityManager.exportPrivateKey(leaf.privateKey),
  }, null, 2), 'utf-8');
}

async function seedConfig(home, { deviceId = 'device-legacy', deviceName = 'legacy' } = {}) {
  await writeFile(
    join(home, 'config.json'),
    JSON.stringify({ storagePath: join(home, 'store.jsonl'), deviceId, deviceName }, null, 2),
    'utf-8',
  );
}

async function seedStoreEvent(home) {
  await writeFile(join(home, 'store.jsonl'), '{"id":"e1"}\n', 'utf-8');
}

function invokeInit(home, args = [], extraEnv = {}) {
  const env = { ...process.env, MEBULAR_HOME: home, ...extraEnv };
  delete env.MEBULAR_DEVICE_ID;
  delete env.MEBULAR_DEVICE_NAME;
  delete env.MEBULAR_STORAGE_PATH;
  return spawnSync(process.execPath, [CLI, 'init', ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 30000,
  });
}

function invokeStatus(home, extraEnv = {}) {
  const env = {
    ...process.env,
    MEBULAR_HOME: home,
    MEBULAR_NETWORK_ENABLED: '0',
    ...extraEnv,
  };
  delete env.MEBULAR_STORAGE_PATH;
  return spawnSync(process.execPath, [CLI, 'status'], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 30000,
  });
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf-8'));
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('mebular init identity contract', () => {
  it('fresh home: creates identity; config has no deviceId/deviceName', async () => {
    const home = await makeHome();

    const result = invokeInit(home, ['--device-name', 'fresh-device']);

    expect(result.status).toBe(0);
    const config = await readJson(join(home, 'config.json'));
    expect(config).not.toHaveProperty('deviceId');
    expect(config).not.toHaveProperty('deviceName');
    expect(config.storagePath).toBe(join(home, 'store.jsonl'));
    const identity = await readJson(join(home, 'store.jsonl.identity.json'));
    expect(identity.deviceId).toMatch(/^device-/);
    expect(identity.deviceName).toBe('fresh-device');
  });

  it('explicit --device-id bootstraps that id on a fresh home', async () => {
    const home = await makeHome();

    const result = invokeInit(home, ['--device-id', 'device-chosen']);

    expect(result.status).toBe(0);
    expect((await readJson(join(home, 'store.jsonl.identity.json'))).deviceId).toBe('device-chosen');
    expect((await readJson(join(home, 'config.json')))).not.toHaveProperty('deviceId');
  });

  it('existing identity + missing config: restores config without device fields', async () => {
    const home = await makeHome();
    const master = await seedKey(home);
    await seedIdentity(home, master, { deviceId: 'device-keep', deviceName: 'keep-name' });

    const result = invokeInit(home);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('已写入配置');
    const config = await readJson(join(home, 'config.json'));
    expect(config).not.toHaveProperty('deviceId');
    expect(config).not.toHaveProperty('deviceName');
    expect((await readJson(join(home, 'store.jsonl.identity.json'))).deviceId).toBe('device-keep');
  });

  it('valid identity + legacy config mismatch: self-heals, backs up, continues', async () => {
    const home = await makeHome();
    const master = await seedKey(home);
    await seedIdentity(home, master, { deviceId: 'device-real', deviceName: 'real-name' });
    await seedConfig(home, { deviceId: 'device-legacy', deviceName: 'legacy-name' });

    const result = invokeInit(home);

    expect(result.status).toBe(0);
    const config = await readJson(join(home, 'config.json'));
    expect(config).not.toHaveProperty('deviceId');
    expect(config).not.toHaveProperty('deviceName');
    const backup = await readJson(join(home, 'config.json.identity-legacy.bak'));
    expect(backup).toMatchObject({ deviceId: 'device-legacy', deviceName: 'legacy-name' });
    expect((await readJson(join(home, 'store.jsonl.identity.json'))).deviceId).toBe('device-real');
  });

  it('root identity + missing user master key: init exits 2 and does not migrate config', async () => {
    const home = await makeHome();
    const master = await seedKey(home);
    await seedIdentity(home, master, { deviceId: 'device-real' });
    await rm(join(home, 'user-master-key.json'), { force: true });
    await seedConfig(home, { deviceId: 'device-legacy', deviceName: 'legacy' });
    const before = await readFile(join(home, 'config.json'), 'utf-8');

    const result = invokeInit(home);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('IDENTITY_TRUST_ROOT_MISSING');
    expect(await readFile(join(home, 'config.json'), 'utf-8')).toBe(before);
    expect(existsSync(join(home, 'config.json.identity-legacy.bak'))).toBe(false);
    expect(existsSync(join(home, 'user-master-key.json'))).toBe(false);
  });

  it('root identity + malformed user master key: init exits 2 with MASTER_KEY_INVALID', async () => {
    const home = await makeHome();
    const master = await seedKey(home);
    await seedIdentity(home, master, { deviceId: 'device-real' });
    await writeFile(join(home, 'user-master-key.json'), '{ broken', 'utf-8');
    await seedConfig(home, { deviceId: 'device-legacy' });
    const before = await readFile(join(home, 'config.json'), 'utf-8');

    const result = invokeInit(home);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('MASTER_KEY_INVALID');
    expect(await readFile(join(home, 'config.json'), 'utf-8')).toBe(before);
    expect(existsSync(join(home, 'config.json.identity-legacy.bak'))).toBe(false);
  });

  it('delegated identity does not require a root user master key', async () => {
    const home = await makeHome();
    const master = await seedKey(home);
    await seedDelegatedIdentity(home, master, { deviceId: 'device-leaf' });
    await rm(join(home, 'user-master-key.json'), { force: true });
    await writeFile(join(home, 'config.json'), JSON.stringify({ storagePath: join(home, 'store.jsonl') }), 'utf-8');

    const result = invokeInit(home);

    expect(result.status).toBe(0);
    expect(existsSync(join(home, 'user-master-key.json'))).toBe(false);
    expect((await readJson(join(home, 'store.jsonl.identity.json'))).deviceId).toBe('device-leaf');
  });

  it('explicit --device-id conflict is a hard error and writes nothing', async () => {
    const home = await makeHome();
    const master = await seedKey(home);
    await seedIdentity(home, master, { deviceId: 'device-real' });

    const result = invokeInit(home, ['--device-id', 'device-other']);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('IDENTITY_MISMATCH');
    await expect(readJson(join(home, 'config.json'))).rejects.toThrow();
    expect((await readJson(join(home, 'store.jsonl.identity.json'))).deviceId).toBe('device-real');
  });

  it('invalid identity is a hard error and writes nothing', async () => {
    const home = await makeHome();
    await seedKey(home);
    await writeFile(join(home, 'store.jsonl.identity.json'), '{"deviceId":"broken"}\n', 'utf-8');

    const result = invokeInit(home);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('IDENTITY_INVALID');
    await expect(readJson(join(home, 'config.json'))).rejects.toThrow();
  });

  it('missing identity over an existing store is refused', async () => {
    const home = await makeHome();
    await seedKey(home);
    await seedStoreEvent(home);

    const result = invokeInit(home);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('IDENTITY_STORE_OCCUPIED');
    await expect(readJson(join(home, 'config.json'))).rejects.toThrow();
    expect(existsSync(join(home, 'store.jsonl.identity.json'))).toBe(false);
  });

  it('legacy config-only home (empty store) bootstraps identity from the old deviceId', async () => {
    const home = await makeHome();
    await seedKey(home);
    await seedConfig(home, { deviceId: 'device-old', deviceName: 'old-name' });

    const result = invokeInit(home);

    expect(result.status).toBe(0);
    const identity = await readJson(join(home, 'store.jsonl.identity.json'));
    expect(identity).toMatchObject({ deviceId: 'device-old', deviceName: 'old-name' });
    const config = await readJson(join(home, 'config.json'));
    expect(config).not.toHaveProperty('deviceId');
    expect(config).not.toHaveProperty('deviceName');
    expect((await readJson(join(home, 'config.json.identity-legacy.bak'))).deviceId).toBe('device-old');
  });

  it('is idempotent when config already has no identity fields', async () => {
    const home = await makeHome();
    await invokeInit(home);
    const before = await readFile(join(home, 'config.json'), 'utf-8');

    const result = invokeInit(home);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('配置已存在');
    expect(await readFile(join(home, 'config.json'), 'utf-8')).toBe(before);
    expect(existsSync(join(home, 'config.json.identity-legacy.bak'))).toBe(false);
  });

  it('status agrees with identity and ignores env device overrides', async () => {
    const home = await makeHome();
    await invokeInit(home, ['--device-name', 'status-device']);
    const identity = await readJson(join(home, 'store.jsonl.identity.json'));

    const result = invokeStatus(home, {
      MEBULAR_DEVICE_ID: 'device-env-other',
      MEBULAR_DEVICE_NAME: 'env-other',
    });

    expect(result.status).toBe(0);
    const status = JSON.parse(result.stdout);
    expect(status.deviceId).toBe(identity.deviceId);
    expect(status.identityError).toBeUndefined();
    expect(result.stderr).toContain('忽略 MEBULAR_DEVICE_ID');
    const config = await readJson(join(home, 'config.json'));
    expect(config).not.toHaveProperty('deviceId');
    expect(config).not.toHaveProperty('deviceName');
  });
});
