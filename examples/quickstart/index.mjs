#!/usr/bin/env node
// Mebular 快速上手（可执行示例，G0）
//
// 本脚本演示「复制即跑」的最小闭环，并处理首次初始化的身份自举：
//   1. 首次运行调用 Mebular.generateUserMasterKey() 生成用户主密钥对，
//      并把主私钥导出为 PKCS8 持久化到 <dataDir>/master-key.json
//      （生成的主私钥由调用方负责持久化保管——见 README 快速上手）。
//   2. 之后复用同一把主密钥，门面从本地身份文件恢复设备身份。
//   3. 写入一条偏好记忆，再召回并打印。
//
// 前置：先构建（npm run build）。
// 运行：node examples/quickstart/index.mjs
// 数据目录可用 MEBULAR_QUICKSTART_DIR 覆盖，默认落在 examples/quickstart/.data。

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Mebular, HermesMemoryProvider, IdentityManager } from '../../dist/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.MEBULAR_QUICKSTART_DIR ?? join(__dirname, '.data');
const storagePath = join(dataDir, 'store.jsonl');
const masterKeyPath = join(dataDir, 'master-key.json');

async function loadOrCreateUserMasterKey() {
  if (existsSync(masterKeyPath)) {
    const saved = JSON.parse(await readFile(masterKeyPath, 'utf-8'));
    return {
      publicKey: new Uint8Array(Buffer.from(saved.publicKey, 'base64')),
      privateKey: await IdentityManager.importPrivateKey(saved.privateKeyPkcs8),
    };
  }

  const pair = await Mebular.generateUserMasterKey('quickstart-user');
  await mkdir(dataDir, { recursive: true });
  await writeFile(
    masterKeyPath,
    JSON.stringify(
      {
        publicKey: Buffer.from(pair.publicKey).toString('base64'),
        privateKeyPkcs8: await IdentityManager.exportPrivateKey(pair.privateKey),
      },
      null,
      2,
    ),
    'utf-8',
  );
  return pair;
}

const master = await loadOrCreateUserMasterKey();

const mebular = new Mebular({
  storagePath,
  deviceId: 'device-A',
  encryption: {
    userMasterKey: master.publicKey,
    userMasterPrivateKey: master.privateKey,
  },
  network: { enabled: false }, // 单设备先从这里开始
  sync: { autoSync: false },
});

await mebular.initialize();
const provider = new HermesMemoryProvider(mebular);

const before = await provider.retrieveMemory({ types: ['preference'] });
if (before.totalMatches === 0) {
  await provider.storeMemory({
    type: 'preference',
    content: '深色主题',
    metadata: { preferenceType: 'theme', confidence: 0.9 },
  });
}

const { memories, totalMatches } = await provider.retrieveMemory({ types: ['preference'] });
console.log(`已写入并召回 ${totalMatches} 条偏好记忆：`);
for (const memory of memories) {
  console.log(`  - [${memory.type}] ${memory.content}`);
}

await mebular.shutdown();
