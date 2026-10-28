// F-IDENT-1 runtime contract (createMebular via `mebular status`):
// identity is the sole authority; legacy config self-heals with a backup;
// invalid identity / occupied store / missing trust root fail closed with typed codes.

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
  const home = await mkdtemp(join(tmpdir(), 'mebular-identity-contract-'));
  tempDirs.push(home);
  await mkdir(home, { recursive: true });
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
  const manager = new IdentityManager();
  manager.setUserMasterPrivateKey(master.privateKey);
  const identity = await manager.generateDeviceKey(deviceId, deviceName);
  identity.certificate = await manager.issueDeviceCertificate(deviceId);
  await writeFile(join(home, 'store.jsonl.identity.json'), JSON.stringify({
    deviceId: identity.deviceId,
    deviceName: identity.name,
    publicKeyHex: Buffer.from(identity.publicKey).toString('hex'),
    certificate: identity.certificate,
    ...(identity.certificateChain !== undefined ? { certificateChain: identity.certificateChain } : {}),
    createdAt: identity.createdAt,
    privateKeyPkcs8: await IdentityManager.exportPrivateKey(identity.privateKey),
  }, null, 2), 'utf-8');
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
  await writeFile(join(home, 'master-key.json'), JSON.stringify({
    publicKey: Buffer.from(master.publicKey).toString('base64'),
  }, null, 2), 'utf-8');
}

async function seedConfig(home, extra = {}) {
  await writeFile(join(home, 'config.json'), JSON.stringify({
    storagePath: join(home, 'store.jsonl'),
    network: { enabled: false },
    sync: { autoSync: false },
    ...extra,
  }, null, 2), 'utf-8');
}

function invokeStatus(home, extraEnv = {}) {
  const env = {
    ...process.env,
    MEBULAR_HOME: home,
    MEBULAR_NETWORK_ENABLED: '0',
    ...extraEnv,
  };
  delete env.MEBULAR_STORAGE_PATH;
  delete env.MEBULAR_DEVICE_ID;
  delete env.MEBULAR_DEVICE_NAME;
  return spawnSync(process.execPath, [CLI, 'status'], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 45000,
  });
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf-8'));
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('createMebular identity contract', () => {
  it('fresh home bootstraps the store-scoped identity', async () => {
    const home = await makeHome();

    const result = invokeStatus(home);

    expect(result.status).toBe(0);
    const identity = await readJson(join(home, 'store.jsonl.identity.json'));
    expect(identity.deviceId).toMatch(/^device-/);
    expect(JSON.parse(result.stdout).deviceId).toBe(identity.deviceId);
    expect(existsSync(join(home, 'config.json'))).toBe(false);
  });

  it('valid identity + legacy config mismatch self-heals with backup', async () => {
    const home = await makeHome();
    const master = await seedMaster(home);
    await seedIdentity(home, master, { deviceId: 'device-real', deviceName: 'real-name' });
    await seedConfig(home, { deviceId: 'device-legacy', deviceName: 'legacy-name' });

    const result = invokeStatus(home);

    expect(result.status).toBe(0);
    const status = JSON.parse(result.stdout);
    expect(status.deviceId).toBe('device-real');
    expect(result.stderr).toContain('legacy config.deviceId');
    const config = await readJson(join(home, 'config.json'));
    expect(config).not.toHaveProperty('deviceId');
    expect(config).not.toHaveProperty('deviceName');
    const backup = await readJson(join(home, 'config.json.identity-legacy.bak'));
    expect(backup).toMatchObject({ deviceId: 'device-legacy', deviceName: 'legacy-name' });
  });

  it('existing identity + missing config starts', async () => {
    const home = await makeHome();
    const master = await seedMaster(home);
    await seedIdentity(home, master, { deviceId: 'device-real', deviceName: 'real-name' });

    const result = invokeStatus(home);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).deviceId).toBe('device-real');
    // createMebular is a read path: it does not invent config, but it starts on defaults.
    expect(existsSync(join(home, 'config.json'))).toBe(false);
  });

  it('delegated identity + missing config starts (public master key fallback)', async () => {
    const home = await makeHome();
    const master = await seedMaster(home);
    await seedDelegatedIdentity(home, master, { deviceId: 'device-leaf' });
    await rm(join(home, 'user-master-key.json'), { force: true });

    const result = invokeStatus(home);

    expect(result.status).toBe(0);
    const status = JSON.parse(result.stdout);
    expect(status.deviceId).toBe('device-leaf');
    expect(status.identityMode).toBe('delegated');
  });

  it('invalid identity fails closed without touching config', async () => {
    const home = await makeHome();
    await writeFile(join(home, 'store.jsonl.identity.json'), '{"deviceId":"broken"}\n', 'utf-8');
    await seedConfig(home);
    const before = await readFile(join(home, 'config.json'), 'utf-8');

    const result = invokeStatus(home);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('IDENTITY_INVALID');
    expect(await readFile(join(home, 'config.json'), 'utf-8')).toBe(before);
  });

  it('missing identity with existing store fails closed (no auto rekey)', async () => {
    const home = await makeHome();
    await seedConfig(home);
    await writeFile(join(home, 'store.jsonl'), '{"id":"e1"}\n', 'utf-8');

    const result = invokeStatus(home);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('IDENTITY_STORE_OCCUPIED');
    expect(existsSync(join(home, 'store.jsonl.identity.json'))).toBe(false);
    expect(existsSync(join(home, 'user-master-key.json'))).toBe(false);
  });

  it('existing identity + missing user master key fails closed (never generates a new trust root)', async () => {
    const home = await makeHome();
    const master = await seedMaster(home);
    await seedIdentity(home, master);
    await seedConfig(home);
    await rm(join(home, 'user-master-key.json'), { force: true });

    const result = invokeStatus(home);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('IDENTITY_TRUST_ROOT_MISSING');
    expect(existsSync(join(home, 'user-master-key.json'))).toBe(false);
  });
});
