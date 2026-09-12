#!/usr/bin/env node
// 落盘明文扫描（G1）
//
// 在构建产物上验证：启用 user 作用域静态加密后，
//   1. store.jsonl 十六进制/UTF-8 扫描均无明文记忆命中；
//   2. 每行都是 enc:v1: 密文信封；
//   3. 同用户主密钥可解密并读回记忆（事件 ID/签名语义不变）；
//   4. 错密钥诚实报 STORAGE_DECRYPT_FAILED。
//
// 前置：npm run build
// 运行：node scripts/scan-at-rest.mjs

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

let allPassed = true;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `（${detail}）` : ''}`);
  if (!ok) allPassed = false;
};

console.log('Mebular G1 落盘明文扫描');
console.log('========================');

const mebular = await import(join(rootDir, 'dist', 'index.js'));
const { Mebular, IdentityManager, JsonFileStorage, StorageCipher } = mebular;

const dir = await mkdtemp(join(tmpdir(), 'mebular-at-rest-scan-'));
const storePath = join(dir, 'store.jsonl');
const marker = `PLAINTEXT-MARKER-${crypto.randomUUID()}`;

try {
  const master = await new IdentityManager().generateUserMasterKey();
  const masterKeys = { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey };

  // 写入
  const app = new Mebular({
    storagePath: storePath,
    deviceId: 'device-scan',
    encryption: { level: 'user', ...masterKeys },
    sync: { autoSync: false },
  });
  await app.initialize();
  const node = await app.graph.createNode('fact', { text: marker });
  await app.shutdown();

  // 扫描
  const raw = await readFile(storePath, 'utf-8');
  const hex = Buffer.from(raw, 'utf-8').toString('hex');
  check('UTF-8 扫描无明文命中', !raw.includes(marker));
  check('十六进制扫描无明文命中', !hex.includes(Buffer.from(marker, 'utf-8').toString('hex')));

  const lines = raw.trim().split('\n').filter((l) => l.trim() !== '');
  check('落盘行均为 enc:v1: 密文', lines.length > 0 && lines.every((l) => l.startsWith('enc:v1:')));

  // 正确密钥可解密
  const userCipher = await StorageCipher.fromUserMasterPrivateKey(master.privateKey);
  const reader = await JsonFileStorage.open(storePath, { cipher: userCipher });
  const readBack = await reader.getNode(node.id);
  check('用户密钥可解密读回记忆', readBack?.content?.text === marker);
  await reader.close();

  // 事件寻址/签名基于明文
  const reopened = new Mebular({
    storagePath: storePath,
    deviceId: 'device-scan',
    encryption: { level: 'user', ...masterKeys },
    sync: { autoSync: false },
  });
  await reopened.initialize();
  const events = await reopened.eventLog.listEvents();
  check('事件内容寻址仍为 sha256（基于明文）', events.length === 1 && events[0].id.startsWith('sha256:'));
  await reopened.shutdown();

  // 错密钥诚实报错
  const other = await new IdentityManager().generateUserMasterKey();
  const wrong = await StorageCipher.fromUserMasterPrivateKey(other.privateKey);
  let wrongCode = null;
  try {
    await JsonFileStorage.open(storePath, { cipher: wrong });
  } catch (error) {
    wrongCode = error?.code ?? null;
  }
  check('错密钥诚实报 STORAGE_DECRYPT_FAILED', wrongCode === 'STORAGE_DECRYPT_FAILED', String(wrongCode));

  // 缺密钥诚实报错
  let missingCode = null;
  try {
    await JsonFileStorage.open(storePath);
  } catch (error) {
    missingCode = error?.code ?? null;
  }
  check('缺密钥诚实报 STORAGE_KEY_MISSING', missingCode === 'STORAGE_KEY_MISSING', String(missingCode));
} catch (error) {
  console.log('  ✗ 扫描异常:', String(error?.stack ?? error).substring(0, 600));
  allPassed = false;
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log('='.repeat(24));
if (allPassed) {
  console.log('✓ G1 落盘明文扫描通过');
  process.exit(0);
} else {
  console.log('✗ G1 落盘明文扫描失败');
  process.exit(1);
}
