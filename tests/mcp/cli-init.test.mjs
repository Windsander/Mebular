// `mebular init` must not create a config with a different deviceId than an
// existing identity file. This is the partial-initialization path that can leave
// a home unable to start with IDENTITY_NOT_INITIALIZED.
//
// The tests use a dummy user-master-key.json because init only needs the key file
// to exist; no core runtime is initialized here.

import { describe, it, expect, afterEach } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  await writeFile(join(home, 'user-master-key.json'), '{}\n', 'utf-8');
}

async function seedIdentity(home, { deviceId = 'localhost', deviceName = 'localhost' } = {}) {
  await writeFile(
    join(home, 'store.jsonl.identity.json'),
    JSON.stringify({ deviceId, deviceName }, null, 2),
    'utf-8',
  );
}

async function seedConfig(home, { deviceId = 'device-local' } = {}) {
  await writeFile(
    join(home, 'config.json'),
    JSON.stringify({ storagePath: join(home, 'store.jsonl'), deviceId }, null, 2),
    'utf-8',
  );
}

function invokeInit(home, args = []) {
  const env = { ...process.env, MEBULAR_HOME: home };
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

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf-8'));
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('mebular init identity invariants', () => {
  it('restores a missing config from an existing identity instead of writing the default deviceId', async () => {
    const home = await makeHome();
    await seedKey(home);
    await seedIdentity(home, { deviceId: 'localhost', deviceName: 'localhost' });

    const result = invokeInit(home);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('已按既有身份恢复配置');
    const config = await readJson(join(home, 'config.json'));
    expect(config.deviceId).toBe('localhost');
    expect(config.deviceName).toBe('localhost');
    expect(config.storagePath).toBe(join(home, 'store.jsonl'));
  });

  it('refuses to overwrite a mismatched config and reports IDENTITY_MISMATCH', async () => {
    const home = await makeHome();
    await seedKey(home);
    await seedConfig(home, { deviceId: 'device-local' });
    await seedIdentity(home, { deviceId: 'localhost', deviceName: 'localhost' });

    const result = invokeInit(home);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('IDENTITY_MISMATCH');
    expect(result.stderr).toContain('localhost');
    expect(result.stderr).toContain('device-local');
    expect((await readJson(join(home, 'config.json'))).deviceId).toBe('device-local');
    expect((await readJson(join(home, 'store.jsonl.identity.json'))).deviceId).toBe('localhost');
  });

  it('refuses an explicit --device-id that conflicts with the existing identity', async () => {
    const home = await makeHome();
    await seedKey(home);
    await seedIdentity(home, { deviceId: 'localhost' });

    const result = invokeInit(home, ['--device-id', 'device-other']);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('IDENTITY_MISMATCH');
    await expect(readJson(join(home, 'config.json'))).rejects.toThrow();
  });

  it('is idempotent when config and identity already match', async () => {
    const home = await makeHome();
    await seedKey(home);
    await seedConfig(home, { deviceId: 'localhost' });
    await seedIdentity(home, { deviceId: 'localhost' });
    const before = await readFile(join(home, 'config.json'), 'utf-8');

    const result = invokeInit(home);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('配置已存在，未覆盖');
    expect(await readFile(join(home, 'config.json'), 'utf-8')).toBe(before);
  });

  it('keeps the normal fresh-init path when no identity exists', async () => {
    const home = await makeHome();
    await seedKey(home);

    const result = invokeInit(home);

    expect(result.status).toBe(0);
    const config = await readJson(join(home, 'config.json'));
    expect(config.deviceId).toMatch(/^device-/);
    expect(config.deviceName).toBeUndefined();
  });
});
