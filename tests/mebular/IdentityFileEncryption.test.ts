// 门面身份文件加密存放测试（Phase 5.1）
//
// 覆盖：口令初始化写加密封套、重载解锁、错误口令/缺口令的诚实失败、
// 明文旧文件的自动迁移、keychain 接缝、无口令时的明文向后兼容。

import { describe, it, expect, afterEach } from '@jest/globals';
import { readFile, rm } from 'fs/promises';
import { Mebular } from '../../src/mebular.js';
import { generateMasterKeyPair, masterPublicKeyBytes } from '../p2p/helpers.js';

interface IdentityFileShape {
  deviceId: string;
  publicKeyHex: string;
  privateKeyPkcs8?: string;
  privateKeyEncrypted?: { kdf: string; cipher: string; iterations: number };
}

const created: string[] = [];
function storagePathFor(name: string): string {
  const path = `.tmp-test-identity-${name}-${Date.now()}.jsonl`;
  created.push(path);
  return path;
}

afterEach(async () => {
  for (const path of created.splice(0)) {
    await rm(path, { force: true });
    await rm(`${path}.identity.json`, { force: true });
  }
});

async function readIdentityFile(storagePath: string): Promise<IdentityFileShape> {
  return JSON.parse(await readFile(`${storagePath}.identity.json`, 'utf-8')) as IdentityFileShape;
}

describe('身份文件私钥加密存放', () => {
  it('配置口令时写加密封套（无明文字段），同口令重载身份一致', async () => {
    const storagePath = storagePathFor('sealed');
    const master = await generateMasterKeyPair();
    const masterPub = await masterPublicKeyBytes(master);

    const first = new Mebular({
      storagePath,
      deviceId: 'device-sealed',
      encryption: {
        userMasterKey: masterPub,
        userMasterPrivateKey: master.privateKey,
        passphrase: 's3cure-passphrase',
      },
      sync: { autoSync: false },
    });
    await first.initialize();
    const publicKeyHex = first.identity.getDeviceKey('device-sealed')!.publicKey;
    await first.shutdown();

    const record = await readIdentityFile(storagePath);
    expect(record.privateKeyPkcs8).toBeUndefined();
    expect(record.privateKeyEncrypted).toMatchObject({
      kdf: 'PBKDF2',
      cipher: 'AES-256-GCM',
      iterations: 210_000,
    });

    // 重载：同口令解锁，公钥不变（同一把设备密钥）
    const second = new Mebular({
      storagePath,
      deviceId: 'device-sealed',
      encryption: { userMasterKey: masterPub, passphrase: 's3cure-passphrase' },
      sync: { autoSync: false },
    });
    await second.initialize();
    expect(
      Buffer.from(second.identity.getDeviceKey('device-sealed')!.publicKey).equals(
        Buffer.from(publicKeyHex),
      ),
    ).toBe(true);
    await second.shutdown();
  });

  it('错误口令解锁失败（IDENTITY_UNLOCK_FAILED）', async () => {
    const storagePath = storagePathFor('wrong-pw');
    const master = await generateMasterKeyPair();
    const masterPub = await masterPublicKeyBytes(master);

    const first = new Mebular({
      storagePath,
      deviceId: 'device-wrong',
      encryption: {
        userMasterKey: masterPub,
        userMasterPrivateKey: master.privateKey,
        passphrase: 'right',
      },
      sync: { autoSync: false },
    });
    await first.initialize();
    await first.shutdown();

    const second = new Mebular({
      storagePath,
      deviceId: 'device-wrong',
      encryption: { userMasterKey: masterPub, passphrase: 'WRONG' },
      sync: { autoSync: false },
    });
    await expect(second.initialize()).rejects.toMatchObject({ code: 'IDENTITY_UNLOCK_FAILED' });
  });

  it('加密文件缺口令时报 IDENTITY_LOCKED', async () => {
    const storagePath = storagePathFor('locked');
    const master = await generateMasterKeyPair();
    const masterPub = await masterPublicKeyBytes(master);

    const first = new Mebular({
      storagePath,
      deviceId: 'device-locked',
      encryption: {
        userMasterKey: masterPub,
        userMasterPrivateKey: master.privateKey,
        passphrase: 'pw',
      },
      sync: { autoSync: false },
    });
    await first.initialize();
    await first.shutdown();

    const second = new Mebular({
      storagePath,
      deviceId: 'device-locked',
      encryption: { userMasterKey: masterPub },
      sync: { autoSync: false },
    });
    await expect(second.initialize()).rejects.toMatchObject({ code: 'IDENTITY_LOCKED' });
  });

  it('明文旧文件在首次带口令初始化时自动迁移为加密存放', async () => {
    const storagePath = storagePathFor('migrate');
    const master = await generateMasterKeyPair();
    const masterPub = await masterPublicKeyBytes(master);

    // 旧行为：无口令 → 明文
    const legacy = new Mebular({
      storagePath,
      deviceId: 'device-migrate',
      encryption: { userMasterKey: masterPub, userMasterPrivateKey: master.privateKey },
      sync: { autoSync: false },
    });
    await legacy.initialize();
    await legacy.shutdown();
    expect((await readIdentityFile(storagePath)).privateKeyPkcs8).toBeDefined();

    // 带口令重开 → 自动迁移
    const upgraded = new Mebular({
      storagePath,
      deviceId: 'device-migrate',
      encryption: { userMasterKey: masterPub, passphrase: 'new-pw' },
      sync: { autoSync: false },
    });
    await upgraded.initialize();
    await upgraded.shutdown();
    const record = await readIdentityFile(storagePath);
    expect(record.privateKeyPkcs8).toBeUndefined();
    expect(record.privateKeyEncrypted).toBeDefined();

    // 迁移后再无口令加载 → 诚实拒绝
    const locked = new Mebular({
      storagePath,
      deviceId: 'device-migrate',
      encryption: { userMasterKey: masterPub },
      sync: { autoSync: false },
    });
    await expect(locked.initialize()).rejects.toMatchObject({ code: 'IDENTITY_LOCKED' });
  });

  it('未直接配置口令时经 keychain 接缝获取', async () => {
    const storagePath = storagePathFor('keychain');
    const master = await generateMasterKeyPair();
    const masterPub = await masterPublicKeyBytes(master);

    const keychain = { getPassphrase: async (deviceId: string) => (deviceId === 'device-kc' ? 'kc-pw' : null) };
    const first = new Mebular({
      storagePath,
      deviceId: 'device-kc',
      encryption: {
        userMasterKey: masterPub,
        userMasterPrivateKey: master.privateKey,
        keychain,
      },
      sync: { autoSync: false },
    });
    await first.initialize();
    await first.shutdown();
    expect((await readIdentityFile(storagePath)).privateKeyEncrypted).toBeDefined();

    // keychain 返回 null → 诚实报 locked
    const noKey = new Mebular({
      storagePath,
      deviceId: 'device-kc',
      encryption: { userMasterKey: masterPub, keychain: { getPassphrase: async () => null } },
      sync: { autoSync: false },
    });
    await expect(noKey.initialize()).rejects.toMatchObject({ code: 'IDENTITY_LOCKED' });
  });

  it('无口令初始化保持明文格式（向后兼容）', async () => {
    const storagePath = storagePathFor('plain');
    const master = await generateMasterKeyPair();
    const masterPub = await masterPublicKeyBytes(master);

    const app = new Mebular({
      storagePath,
      deviceId: 'device-plain',
      encryption: { userMasterKey: masterPub, userMasterPrivateKey: master.privateKey },
      sync: { autoSync: false },
    });
    await app.initialize();
    await app.shutdown();

    const record = await readIdentityFile(storagePath);
    expect(record.privateKeyPkcs8).toBeDefined();
    expect(record.privateKeyEncrypted).toBeUndefined();
  });
});
