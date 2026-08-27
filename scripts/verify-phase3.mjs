#!/usr/bin/env node
// Phase 3 验证脚本（图同步）
//
// 对照 docs.design/phase-3-plan.md 的毕业条件：
//   1. 图变更产生带签名事件（事件类型全覆盖）
//   2. 双设备在认证加密信道上完成向量时钟交换与增量同步（推/拉/双向）
//   3. 并发修改按确定性规则收敛，冲突以 SyncConflict 上报
//   4. 离线写入持久化，重连后自动同步收敛
//   5. 接收事件全部验签，伪造事件被拒绝
//   6. 本脚本通过；单元 + 集成测试覆盖核心路径

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

console.log('Mebular Phase 3 验证脚本（图同步）');
console.log('====================================');

let allPassed = true;

// 1. 检查 Phase 3 核心文件
console.log('\n[1/5] 检查 Phase 3 核心文件...');
const phase3Files = [
  'src/storage/JsonFileStorage.ts',
  'src/eventlog/EventLog.ts',
  'src/sync/protocol.ts',
  'src/sync/apply.ts',
  'src/sync/syncmgr/SyncManager.ts',
  'tests/storage/JsonFileStorage.test.ts',
  'tests/eventlog/EventLog.test.ts',
  'tests/sync/apply.test.ts',
  'tests/sync/SyncManager.test.ts',
  'tests/integration/GraphSync.integration.test.ts',
  'docs.design/phase-3-plan.md',
];

for (const file of phase3Files) {
  if (!existsSync(join(rootDir, file))) {
    console.log(`  ✗ 缺失: ${file}`);
    allPassed = false;
  } else {
    console.log(`  ✓ ${file}`);
  }
}

// 2. TypeScript 编译
console.log('\n[2/5] 运行 TypeScript 编译...');
try {
  execSync('npm run build', { cwd: rootDir, encoding: 'utf-8', timeout: 120000 });
  console.log('  ✓ 编译成功');
} catch (error) {
  console.log('  ✗ 编译失败');
  console.log('  错误:', String(error.message).substring(0, 500));
  allPassed = false;
}

// 3. 全量测试（Phase 3 涉及存储/事件/同步/集成，直接跑全量防回归）
console.log('\n[3/5] 运行全量测试套件...');
try {
  const output = execSync(
    'node --experimental-vm-modules node_modules/jest/bin/jest.js --silent',
    { cwd: rootDir, encoding: 'utf-8', timeout: 180000 },
  );
  const summary = output.split('\n').filter((line) => line.startsWith('Tests:'));
  console.log('  ✓ 测试通过', summary.length ? `(${summary[0].trim()})` : '');
} catch (error) {
  console.log('  ✗ 测试失败');
  console.log('  错误:', String(error.message).substring(0, 500));
  allPassed = false;
}

// 4. 毕业条件关键实现点抽查（静态）
console.log('\n[4/5] 抽查毕业条件关键实现点...');
const checkpoints = [
  ['src/eventlog/EventLog.ts', 'computeEventId', '事件内容寻址 ID（天然幂等）'],
  ['src/eventlog/EventLog.ts', 'verifyEvent', '事件验签（伪造拒绝的前提）'],
  ['src/eventlog/EventLog.ts', 'missingEvents', '按向量时钟计算增量集合'],
  ['src/core/GraphStore.ts', "type: 'node_created'", '图变更事件化接线'],
  ['src/core/GraphStore.ts', "type: 'tag_added'", '标签操作事件化'],
  ['src/sync/protocol.ts', 'sync-hello', '同步线协议消息'],
  ['src/sync/apply.ts', 'resolveConcurrent', '并发冲突确定性裁决'],
  ['src/sync/apply.ts', 'tombstone', '删除墓碑防复活'],
  ['src/sync/syncmgr/SyncManager.ts', 'attachToNode', '认证后自动同步'],
  ['src/sync/syncmgr/SyncManager.ts', 'getPendingEvents', '离线待同步队列'],
  ['src/storage/JsonFileStorage.ts', 'replay', '持久化重放恢复'],
];

for (const [file, marker, label] of checkpoints) {
  const fullPath = join(rootDir, file);
  const hit = existsSync(fullPath) && readFileSync(fullPath, 'utf-8').includes(marker);
  if (hit) {
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  ✗ ${label}（${file} 缺少 ${marker}）`);
    allPassed = false;
  }
}

// 5. 功能冒烟：对构建产物跑一次真实的双设备同步
console.log('\n[5/5] 功能冒烟：构建产物上的双设备同步...');
try {
  const mebular = await import(join(rootDir, 'dist', 'index.js'));
  const {
    GraphStore,
    EventLog,
    MemoryStorage,
    SyncManager,
    SecureChannelSyncTransport,
  } = mebular;
  const { InMemoryHub } = await import(join(rootDir, 'dist', 'p2p', 'transport', 'InMemoryTransport.js'));
  const { SecureChannelImpl } = await import(join(rootDir, 'dist', 'p2p', 'secure', 'SecureChannelImpl.js'));

  const createDevice = async (deviceId) => {
    const keyPair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
    const storage = new MemoryStorage();
    const eventLog = new EventLog(storage, deviceId, {
      signer: { deviceId, privateKey: keyPair.privateKey },
    });
    const store = new GraphStore({ storage, author: deviceId, eventLog });
    const syncManager = new SyncManager({ eventLog, storage, deviceId });
    const peerId = { multihash: publicKey, pubKey: publicKey, id: deviceId };
    return { deviceId, storage, eventLog, store, syncManager, publicKey, peerId };
  };

  const a = await createDevice('device-A');
  const b = await createDevice('device-B');

  const n1 = await a.store.createNode('fact', { text: 'smoke-A' });
  await b.store.createNode('fact', { text: 'smoke-B' });

  // 事件必须带内容寻址 ID 与签名
  const [eventA] = await a.eventLog.listEvents();
  if (!eventA.id.startsWith('sha256:') || !eventA.signature) {
    throw new Error('事件缺少内容寻址 ID 或签名');
  }
  const verified = await EventLog.verifyEvent(eventA, a.publicKey);
  if (!verified) {
    throw new Error('本地事件验签失败');
  }

  const hub = new InMemoryHub();
  const [connA, connB] = hub.createLinkedPair(a.peerId, b.peerId);
  const channelA = new SecureChannelImpl(connA);
  const channelB = new SecureChannelImpl(connB);
  await Promise.all([channelA.start(), channelB.start()]);

  const [resultA] = await Promise.all([
    a.syncManager.syncWithDevice(
      new SecureChannelSyncTransport(channelA),
      { deviceId: b.deviceId, publicKey: b.publicKey },
      { direction: 'bidirectional' },
    ),
    b.syncManager.acceptSync(
      new SecureChannelSyncTransport(channelB),
      { deviceId: a.deviceId, publicKey: a.publicKey },
    ),
  ]);

  const nodeOnB = await b.store.getNode(n1.id);
  if (!nodeOnB || nodeOnB.content.text !== 'smoke-A') {
    throw new Error('B 未收敛到 A 的节点');
  }
  if (resultA.sentEvents !== 1 || resultA.receivedEvents !== 1) {
    throw new Error(`同步结果异常: ${JSON.stringify(resultA)}`);
  }

  await channelA.close();
  await channelB.close();
  console.log('  ✓ 双设备签名事件同步收敛（验签 + 内容寻址 + 加密信道）');
} catch (error) {
  console.log('  ✗ 功能冒烟失败');
  console.log('  错误:', String(error.message ?? error).substring(0, 500));
  allPassed = false;
}

console.log('\n' + '='.repeat(60));
if (allPassed) {
  console.log('✓ Phase 3 验证通过');
  process.exit(0);
} else {
  console.log('✗ Phase 3 验证失败，请修复上述问题');
  process.exit(1);
}
