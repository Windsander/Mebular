#!/usr/bin/env node
// Phase 1 验证和测试脚本

import { execSync } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

console.log('Mebular Phase 1 验证脚本');
console.log('=========================');

let allPassed = true;

// 1. 检查核心文件
console.log('\n[1/5] 检查核心文件...');
const coreFiles = [
  'src/types/index.ts',
  'src/types/common.ts',
  'src/types/node.ts',
  'src/types/edge.ts',
  'src/types/event.ts',
  'src/types/config.ts',
  'src/types/vectorclock.ts',
  'src/crypto/index.ts',
  'src/crypto/signature.ts',
  'src/crypto/encryption.ts',
  'src/storage/StorageAdapter.ts',
  'src/storage/MemoryStorage.ts',
  'src/core/GraphStore.ts',
  'src/eventlog/EventLog.ts',
  'src/eventlog/index.ts',
  'src/sync/index.ts',
  'src/sync/vectorclock/VectorClock.ts',
  'src/sync/vectorclock/index.ts',
  'src/sync/syncmgr/SyncManager.ts',
  'src/sync/syncmgr/index.ts',
  'src/index.ts',
];

for (const file of coreFiles) {
  const fullPath = join(rootDir, file);
  if (!existsSync(fullPath)) {
    console.log(`  ✗ 缺失: ${file}`);
    allPassed = false;
  } else {
    console.log(`  ✓ ${file}`);
  }
}

// 2. 运行 tsc 编译
console.log('\n[2/5] 运行 TypeScript 编译...');
try {
  const output = execSync('npm run build', {
    cwd: rootDir,
    encoding: 'utf-8',
    timeout: 60000,
  });
  console.log('  ✓ 编译成功');
  console.log('  输出:', output.substring(0, 200) + '...');
} catch (error) {
  console.log('  ✗ 编译失败');
  console.log('  错误:', (error as Error).message.substring(0, 500));
  allPassed = false;
}

// 3. 运行测试（如果编译成功）
if (allPassed) {
  console.log('\n[3/5] 运行测试...');
  try {
    const output = execSync('npm test', {
      cwd: rootDir,
      encoding: 'utf-8',
      timeout: 60000,
    });
    console.log('  ✓ 测试通过');
    console.log('  输出:', output.substring(0, 300) + '...');
  } catch (error) {
    console.log('  ✗ 测试失败');
    console.log('  错误:', (error as Error).message.substring(0, 500));
    allPassed = false;
  }
} else {
  console.log('\n[3/5] 跳过测试（编译失败）');
}

// 4. 验证 .gitignore 包含 docs.design
console.log('\n[4/5] 验证 .gitignore...');
const gitignorePath = join(rootDir, '.gitignore');
if (existsSync(gitignorePath)) {
  const content = readFileSync(gitignorePath, 'utf-8');
  if (content.includes('docs.design/') || content.includes('docs/')) {
    console.log('  ✓ .gitignore 包含 docs/ 或 docs.design/');
  } else {
    console.log('  ✗ .gitignore 未包含 docs/ 排除规则');
    allPassed = false;
  }
} else {
  console.log('  ✗ .gitignore 不存在');
  allPassed = false;
}

// 5. 验证设计文档位于本地
console.log('\n[5/5] 验证设计文档位置...');
const designDocs = [
  'docs.design/mebular-design-001.md',
  'docs.design/project-status.md',
  'docs.design/spec-001-memory-model.md',
  'docs.design/spec-002-crypto-identity.md',
  'docs.design/spec-003-sync-protocol.md',
  'docs.design/spec-004-api.md',
];

for (const doc of designDocs) {
  const fullPath = join(rootDir, doc);
  if (!existsSync(fullPath)) {
    console.log(`  ✗ 缺失: ${doc}`);
    allPassed = false;
  } else {
    console.log(`  ✓ ${doc}`);
  }
}

console.log('\n' + '='.repeat(60));
if (allPassed) {
  console.log('✓ Phase 1 验证通过');
  console.log('\n可以准备提交：');
  console.log('  git add -A');
  console.log('  git commit -m "feat: complete Mebular core engine Phase 1"');
  console.log('  git push origin main');
  process.exit(0);
} else {
  console.log('✗ Phase 1 验证失败，请修复上述问题');
  process.exit(1);
}
