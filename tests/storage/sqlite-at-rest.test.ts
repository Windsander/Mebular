// SQLite 存储静态加密（G4：复用 G1 加密落点）
//
// 验证 SqliteStorage 与门面 storageAdapter='sqlite' 在 level='user' 下
// 落盘为密文、含密钥可解密重开、缺/错密钥诚实报错。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { SqliteStorage } from '../../src/storage/SqliteStorage.js';
import { StorageCipher } from '../../src/crypto/StorageCipher.js';
import { Mebular } from '../../src/mebular.js';
import { IdentityManager } from '../../src/crypto/IdentityManager.js';
import { ErrorCodes } from '../../src/errors.js';
import type { Node } from '../../src/types/index.js';

function sqliteAvailable(): boolean {
  const getBuiltin = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
  if (typeof getBuiltin !== 'function') return false;
  try {
    return getBuiltin('node:sqlite') != null;
  } catch {
    return false;
  }
}
const itIfSqlite = sqliteAvailable() ? it : it.skip;

const MARKER = 'SQLITE-AT-REST-MARKER-9c1f';

function makeNode(id: string, text: string): Node {
  return {
    id,
    type: 'fact',
    content: { text },
    labels: [],
    createdBy: 'device-A',
    signature: '',
    createdAt: 1000,
    updatedAt: 1000,
    validFrom: 1000,
    validTo: 9999999999999,
    tags: [],
  };
}

describe('SQLite 静态加密（复用 G1 落点）', () => {
  let dir: string;
  let file: string;
  let master: { publicKey: Uint8Array; privateKey: CryptoKey };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mebular-sqlite-at-rest-'));
    file = join(dir, 'store.sqlite');
    master = await new IdentityManager().generateUserMasterKey();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  itIfSqlite('SqliteStorage：密文落盘、可解密重开、缺/错密钥诚实报错', async () => {
    const cipher = await StorageCipher.fromUserMasterPrivateKey(master.privateKey);
    const storage = await SqliteStorage.open(file, { cipher });
    await storage.putNode(makeNode('n1', MARKER));
    await storage.close();

    const raw = await readFile(file);
    expect(raw.includes(Buffer.from(MARKER, 'utf-8'))).toBe(false);

    const reopened = await SqliteStorage.open(file, { cipher });
    expect((await reopened.getNode('n1'))?.content).toEqual({ text: MARKER });
    await reopened.close();

    await expect(SqliteStorage.open(file)).rejects.toMatchObject({
      code: ErrorCodes.STORAGE_KEY_MISSING,
    });

    const other = await new IdentityManager().generateUserMasterKey();
    const wrong = await StorageCipher.fromUserMasterPrivateKey(other.privateKey);
    await expect(SqliteStorage.open(file, { cipher: wrong })).rejects.toMatchObject({
      code: ErrorCodes.STORAGE_DECRYPT_FAILED,
    });
  });

  itIfSqlite('门面 storageAdapter=sqlite + level=user：落盘无明文、重开视图一致', async () => {
    const masterKeys = {
      userMasterKey: master.publicKey,
      userMasterPrivateKey: master.privateKey,
    };
    const first = new Mebular({
      storagePath: file,
      deviceId: 'device-A',
      storageAdapter: 'sqlite',
      encryption: { level: 'user', ...masterKeys },
      sync: { autoSync: false },
    });
    await first.initialize();
    const node = await first.graph.createNode('fact', { text: MARKER });
    await first.shutdown();

    const raw = await readFile(file);
    expect(raw.includes(Buffer.from(MARKER, 'utf-8'))).toBe(false);

    const second = new Mebular({
      storagePath: file,
      deviceId: 'device-A',
      storageAdapter: 'sqlite',
      encryption: { level: 'user', ...masterKeys },
      sync: { autoSync: false },
    });
    await second.initialize();
    expect((await second.graph.getNode(node.id))?.content).toEqual({ text: MARKER });
    await second.shutdown();
  });
});
