#!/usr/bin/env node
// Phase 4 验证脚本（Hermes 集成）
//
// 对照 docs.design/phase-4-plan.md 的毕业条件：
//   1. Mebular 门面类收口生命周期与错误体系（initialize/shutdown/身份恢复）
//   2. 类型化记忆模型 MemoryStore（五类节点 + 校验 + 时间窗）
//   3. 召回与查询增强（traverse / 关键词基线 / 可插拔 VectorIndex）
//   4. HermesMemoryProvider 七方法（spec-004 Hermes 面）
//   5. Hermes 既有记忆导入器（幂等键随图同步）
//   6. 端到端「Hermes 的一天」双设备收敛（InMemoryHub 语义验证；libp2p 降级 M5 前置）
//   7. 本脚本通过；单元 + 集成测试覆盖核心路径

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

console.log('Mebular Phase 4 验证脚本（Hermes 集成）');
console.log('======================================');

let allPassed = true;

// 1. 检查 Phase 4 核心文件
console.log('\n[1/5] 检查 Phase 4 核心文件...');
const phase4Files = [
  'src/mebular.ts',
  'src/errors.ts',
  'src/memory/types.ts',
  'src/memory/MemoryStore.ts',
  'src/memory/VectorIndex.ts',
  'src/types/traverse.ts',
  'src/hermes/types.ts',
  'src/hermes/HermesMemoryProvider.ts',
  'src/hermes/import/HermesImporter.ts',
  'src/hermes/import/markdown.ts',
  'tests/mebular/Mebular.test.ts',
  'tests/memory/MemoryStore.test.ts',
  'tests/memory/recall.test.ts',
  'tests/hermes/HermesMemoryProvider.test.ts',
  'tests/hermes/import.test.ts',
  'tests/integration/HermesDay.integration.test.ts',
  'docs.design/phase-4-plan.md',
];

for (const file of phase4Files) {
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

// 3. 全量测试（Phase 4 收口牵动 Phase 1-3 组件，跑全量防回归）
console.log('\n[3/5] 运行全量测试套件...');
try {
  const output = execSync(
    'node --experimental-vm-modules node_modules/jest/bin/jest.js --silent',
    { cwd: rootDir, encoding: 'utf-8', timeout: 240000 },
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
  ['src/mebular.ts', 'class Mebular', '门面类（生命周期收口）'],
  ['src/mebular.ts', 'NETWORK_LIBP2P_NOT_AVAILABLE', 'libp2p 占位诚实报错'],
  ['src/errors.ts', 'ErrorCodes', '统一错误体系（spec-004）'],
  ['src/crypto/IdentityManager.ts', 'canonicalCertificateData', '身份证书路径统一'],
  ['src/core/GraphStore.ts', 'async traverse', '图遍历（BFS/方向/类型过滤）'],
  ['src/memory/MemoryStore.ts', 'listActiveFacts', '活跃事实时间窗查询'],
  ['src/memory/VectorIndex.ts', 'interface VectorIndex', '向量索引可插拔接口'],
  ['src/hermes/HermesMemoryProvider.ts', 'extractMemory', 'provider 抽取方法'],
  ['src/hermes/HermesMemoryProvider.ts', 'getUserProfile', 'provider 用户画像'],
  ['src/hermes/import/HermesImporter.ts', 'importHermesDirectory', '既有记忆整树导入'],
  ['src/hermes/import/HermesImporter.ts', 'import:', '幂等键 label（随图同步）'],
  ['src/storage/MemoryStorage.ts', 'filter.labels', '存储层 labels 过滤（缺口修复）'],
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

// 5. 功能冒烟：构建产物上的门面 + provider + 导入 + 双设备同步
console.log('\n[5/5] 功能冒烟：构建产物上的 Hermes 一天...');
const smokeDir = await mkdtemp(join(tmpdir(), 'mebular-verify-phase4-'));
try {
  const mebular = await import(join(rootDir, 'dist', 'index.js'));
  const { Mebular, IdentityManager, HermesMemoryProvider, HermesImporter, MemoryStore } = mebular;
  const { InMemoryHub } = await import(join(rootDir, 'dist', 'p2p', 'transport', 'InMemoryTransport.js'));

  // 样例 Hermes 记忆文件
  await writeFile(
    join(smokeDir, 'MEMORY.md'),
    '# 长期记忆\n\n## 偏好\n- 喜欢深色主题\n',
    'utf-8',
  );

  const master = await new IdentityManager().generateUserMasterKey();
  const hub = new InMemoryHub();
  const makeFacade = (storagePath, deviceId) => new Mebular({
    storagePath,
    deviceId,
    encryption: { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey },
    network: { enabled: true, provider: hub },
    sync: { autoSync: true },
  });
  const a = makeFacade(join(smokeDir, 'a.jsonl'), 'device-A');
  const b = makeFacade(join(smokeDir, 'b.jsonl'), 'device-B');
  await a.initialize();
  await b.initialize();

  // A：导入 + storeMemory
  const providerA = new HermesMemoryProvider(a);
  const importReport = await new HermesImporter(new MemoryStore(a.graph))
    .importMarkdownFile(join(smokeDir, 'MEMORY.md'));
  if (importReport.entities.length !== 1 || importReport.facts.length !== 1) {
    throw new Error(`导入结果异常: ${JSON.stringify(importReport)}`);
  }
  await providerA.storeMemory({
    type: 'preference',
    content: '深色主题',
    metadata: { preferenceType: 'theme', confidence: 0.9 },
  });

  // 同步
  const syncedA = new Promise((resolve) => a.sync.once('sync-completed', resolve));
  const syncedB = new Promise((resolve) => b.sync.once('sync-completed', resolve));
  await b.node.connectToPeer(a.node.peerId);
  await Promise.all([syncedA, syncedB]);

  // B：同视图
  const providerB = new HermesMemoryProvider(b);
  const profile = await providerB.getUserProfile();
  if (!profile.preferences.some((p) => p.type === 'theme' && p.value === '深色主题')) {
    throw new Error('B 用户画像缺少同步的偏好');
  }
  const retrieved = await providerB.retrieveMemory({ types: ['fact'], query: '深色主题' });
  if (retrieved.totalMatches < 2) {
    throw new Error(`B 检索命中异常: totalMatches=${retrieved.totalMatches}`);
  }

  await a.shutdown();
  await b.shutdown();
  console.log('  ✓ 门面 + provider + 导入 + 双设备同步收敛（构建产物）');
} catch (error) {
  console.log('  ✗ 功能冒烟失败');
  console.log('  错误:', String(error.message ?? error).substring(0, 500));
  allPassed = false;
} finally {
  await rm(smokeDir, { recursive: true, force: true });
}

console.log('\n' + '='.repeat(60));
if (allPassed) {
  console.log('✓ Phase 4 验证通过');
  process.exit(0);
} else {
  console.log('✗ Phase 4 验证失败，请修复上述问题');
  process.exit(1);
}
