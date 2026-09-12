// 记忆静态加密测试（G1）
//
// 覆盖：JsonFileStorage 行级密文落盘与重放解密；HKDF user 作用域派生
// 的跨设备确定性；缺密钥 / 错密钥诚实报错；compact 后仍为密文；
// 门面 `encryption.level='user'` 的双设备同步视图一致，以及静态加密
// 不破坏事件签名 / 内容寻址（内存明文语义）。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { JsonFileStorage } from '../../src/storage/JsonFileStorage.js';
import { StorageCipher, AT_REST_PREFIX } from '../../src/crypto/StorageCipher.js';
import { EventLog } from '../../src/eventlog/EventLog.js';
import { Mebular } from '../../src/mebular.js';
import { IdentityManager } from '../../src/crypto/IdentityManager.js';
import { ErrorCodes, StorageError } from '../../src/errors.js';
import { InMemoryHub } from '../../src/p2p/transport/InMemoryTransport.js';
import type { Node } from '../../src/types/index.js';
import type { SyncResult } from '../../src/sync/syncmgr/SyncManager.js';

const MARKER = 'SENSITIVE-MEMORY-MARKER-7f3a9c';

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

describe('静态加密（at-rest encryption, G1）', () => {
  let dir: string;
  let file: string;
  let master: { publicKey: Uint8Array; privateKey: CryptoKey };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mebular-at-rest-'));
    file = join(dir, 'store.jsonl');
    master = await new IdentityManager().generateUserMasterKey();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('密文落盘且重放解密：文件中无明文，重开后内存明文完整', async () => {
    const cipher = await StorageCipher.fromUserMasterPrivateKey(master.privateKey);
    const first = await JsonFileStorage.open(file, { cipher });
    await first.putNode(makeNode('n1', MARKER));
    await first.close();

    const raw = await readFile(file, 'utf-8');
    expect(raw).not.toContain(MARKER);
    const lines = raw.trim().split('\n');
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.startsWith(AT_REST_PREFIX)).toBe(true);
    }
    // 十六进制层面也无命中（UTF-8 明文的 hex 片段）
    expect(Buffer.from(raw, 'utf-8').toString('hex')).not.toContain(
      Buffer.from(MARKER, 'utf-8').toString('hex'),
    );

    const reopened = await JsonFileStorage.open(file, { cipher });
    expect((await reopened.getNode('n1'))?.content).toEqual({ text: MARKER });
    await reopened.close();
  });

  it('HKDF user 作用域跨设备确定性：同一主密钥导入后派生同一密钥可互解', async () => {
    const cipherA = await StorageCipher.fromUserMasterPrivateKey(master.privateKey);
    // 模拟另一台设备：仅拿到 PKCS8 主私钥并重新导入
    const pkcs8 = await IdentityManager.exportPrivateKey(master.privateKey);
    const imported = await IdentityManager.importPrivateKey(pkcs8);
    const cipherB = await StorageCipher.fromUserMasterPrivateKey(imported);

    const envelope = await cipherA.encrypt('shared-memory');
    expect(await cipherB.decrypt(envelope)).toBe('shared-memory');
  });

  it('缺密钥诚实报错 STORAGE_KEY_MISSING，不返回空数据', async () => {
    const cipher = await StorageCipher.fromUserMasterPrivateKey(master.privateKey);
    const s = await JsonFileStorage.open(file, { cipher });
    await s.putNode(makeNode('n1', MARKER));
    await s.close();

    await expect(JsonFileStorage.open(file)).rejects.toMatchObject({
      name: 'StorageError',
      code: ErrorCodes.STORAGE_KEY_MISSING,
    });
  });

  it('错密钥诚实报错 STORAGE_DECRYPT_FAILED，不返回垃圾数据', async () => {
    const cipher = await StorageCipher.fromUserMasterPrivateKey(master.privateKey);
    const s = await JsonFileStorage.open(file, { cipher });
    await s.putNode(makeNode('n1', MARKER));
    await s.close();

    const other = await new IdentityManager().generateUserMasterKey();
    const wrong = await StorageCipher.fromUserMasterPrivateKey(other.privateKey);
    await expect(JsonFileStorage.open(file, { cipher: wrong })).rejects.toMatchObject({
      name: 'StorageError',
      code: ErrorCodes.STORAGE_DECRYPT_FAILED,
    });
  });

  it('compact 收紧后仍为密文且可解密', async () => {
    const cipher = await StorageCipher.fromUserMasterPrivateKey(master.privateKey);
    const s = await JsonFileStorage.open(file, { cipher });
    await s.putNode(makeNode('n1', MARKER));
    await s.putNode(makeNode('n1', MARKER));
    await s.putNode(makeNode('n2', 'other'));
    await s.compact();
    await s.close();

    const raw = await readFile(file, 'utf-8');
    expect(raw).not.toContain(MARKER);
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(2); // n1 覆盖写被压掉
    for (const line of lines) {
      expect(line.startsWith(AT_REST_PREFIX)).toBe(true);
    }

    const reopened = await JsonFileStorage.open(file, { cipher });
    expect((await reopened.getNode('n1'))?.content).toEqual({ text: MARKER });
    await reopened.close();
  });

  it('显式 storageKey 接缝可用；长度非法报 CRYPTO_KEY_INVALID', async () => {
    const rawKey = crypto.getRandomValues(new Uint8Array(32));
    const cipher = await StorageCipher.fromRawKey(rawKey);
    const envelope = await cipher.encrypt('via-keychain');
    expect(await cipher.decrypt(envelope)).toBe('via-keychain');

    await expect(StorageCipher.fromRawKey(new Uint8Array(16))).rejects.toMatchObject({
      name: 'StorageError',
      code: ErrorCodes.CRYPTO_KEY_INVALID,
    });
  });

  it('门面 level=user：双设备同步视图一致，双方落盘无明文，用户密钥可解 A 的记忆', async () => {
    const hub = new InMemoryHub();
    const pathA = join(dir, 'a.jsonl');
    const pathB = join(dir, 'b.jsonl');
    const masterKey = { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey };

    const a = new Mebular({
      storagePath: pathA,
      deviceId: 'device-A',
      encryption: { level: 'user', ...masterKey },
      network: { enabled: true, provider: hub },
      sync: { autoSync: true },
    });
    const b = new Mebular({
      storagePath: pathB,
      deviceId: 'device-B',
      encryption: { level: 'user', ...masterKey },
      network: { enabled: true, provider: hub },
      sync: { autoSync: true },
    });
    await a.initialize();
    await b.initialize();

    const node = await a.graph.createNode('fact', { text: MARKER });

    const syncedA = new Promise<SyncResult>((resolve) => a.sync.once('sync-completed', resolve));
    const syncedB = new Promise<SyncResult>((resolve) => b.sync.once('sync-completed', resolve));
    await b.node!.connectToPeer(a.node!.peerId);
    await Promise.all([syncedA, syncedB]);

    // B 视图与 A 一致（同步基于明文，加密不影响）
    expect((await b.graph.getNode(node.id))?.content).toEqual({ text: MARKER });

    await a.shutdown();
    await b.shutdown();

    // 双方落盘均无明文
    const rawA = await readFile(pathA, 'utf-8');
    const rawB = await readFile(pathB, 'utf-8');
    expect(rawA).not.toContain(MARKER);
    expect(rawB).not.toContain(MARKER);

    // 用用户密钥（B 侧导入的主私钥）解密 A 的落盘记忆
    const pkcs8 = await IdentityManager.exportPrivateKey(master.privateKey);
    const userCipher = await StorageCipher.fromUserMasterPrivateKey(
      await IdentityManager.importPrivateKey(pkcs8),
    );
    const reader = await JsonFileStorage.open(pathA, { cipher: userCipher });
    expect((await reader.getNode(node.id))?.content).toEqual({ text: MARKER });
    await reader.close();
  });

  it('门面 level=user 缺主私钥：initialize 抛 STORAGE_KEY_MISSING', async () => {
    const m = new Mebular({
      storagePath: file,
      deviceId: 'device-A',
      encryption: { level: 'user', userMasterKey: master.publicKey },
    });
    await expect(m.initialize()).rejects.toMatchObject({
      code: ErrorCodes.STORAGE_KEY_MISSING,
    });
  });

  it('未实现作用域（device）诚实报错，不静默降级为明文', async () => {
    const m = new Mebular({
      storagePath: file,
      deviceId: 'device-A',
      encryption: { level: 'device', userMasterPrivateKey: master.privateKey },
    });
    await expect(m.initialize()).rejects.toThrow(StorageError);
  });

  it('静态加密不破坏事件签名/内容寻址（重开后可验签）', async () => {
    const masterKey = { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey };
    const first = new Mebular({
      storagePath: file,
      deviceId: 'device-A',
      encryption: { level: 'user', ...masterKey },
      sync: { autoSync: false },
    });
    await first.initialize();
    await first.graph.createNode('fact', { text: MARKER });
    await first.shutdown();

    // 重开：使用同一主密钥即可解密
    const second = new Mebular({
      storagePath: file,
      deviceId: 'device-A',
      encryption: { level: 'user', ...masterKey },
      sync: { autoSync: false },
    });
    await second.initialize();
    const events = await second.eventLog.listEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.id).toMatch(/^sha256:/);
    const deviceKey = second.identity.getDeviceKey('device-A')!;
    await expect(EventLog.verifyEvent(events[0]!, deviceKey.publicKey)).resolves.toBe(true);
    await second.shutdown();
  });
});
