#!/usr/bin/env node
// Phase 0 验证脚本（纯 JS，无类型标注）

import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

const requiredFiles = [
  'package.json',
  'tsconfig.json',
  'src/types/index.ts',
  'src/types/common.ts',
  'src/types/node.ts',
  'src/types/edge.ts',
  'src/types/event.ts',
  'src/types/config.ts',
  'src/crypto/IdentityManager.ts',
  'src/crypto/KeyProtector.ts',
  'src/eventlog/index.ts',
  'src/eventlog/EventLog.ts',
  'src/sync/index.ts',
  'src/sync/syncmgr/index.ts',
  'src/sync/syncmgr/SyncManager.ts',
  'src/sync/vectorclock/index.ts',
  'src/sync/vectorclock/VectorClock.ts',
  'src/index.ts',
  'README.md',
  'docs.design/project-status.md',
];

const requiredDirs = [
  'src/types',
  'src/crypto',
  'src/eventlog',
  'src/sync/syncmgr',
  'src/sync/vectorclock',
  'tests/storage',
];

function checkFile(relPath) {
  const fullPath = join(rootDir, relPath);
  if (!existsSync(fullPath)) {
    return { ok: false, error: 'Missing file: ' + relPath };
  }
  try {
    const stat = statSync(fullPath);
    return { ok: true, size: stat.size };
  } catch (e) {
    return { ok: false, error: 'Cannot stat ' + relPath + ': ' + e };
  }
}

function checkDir(relPath) {
  const fullPath = join(rootDir, relPath);
  if (!existsSync(fullPath)) {
    return { ok: false, error: 'Missing directory: ' + relPath };
  }
  return { ok: true };
}

console.log('Phase 0 验证');
console.log('==========');

let allValid = true;

console.log('\n检查文件:');
for (const file of requiredFiles) {
  const result = checkFile(file);
  if (result.ok) {
    console.log('✓ ' + file + ' (' + result.size + ' 字节)');
  } else {
    console.log('✗ ' + file + ': ' + result.error);
    allValid = false;
  }
}

console.log('\n检查目录:');
for (const dir of requiredDirs) {
  const result = checkDir(dir);
  if (result.ok) {
    console.log('✓ ' + dir + '/');
  } else {
    console.log('✗ ' + dir + ': ' + result.error);
    allValid = false;
  }
}

console.log('\n' + '='.repeat(60));
if (allValid) {
  console.log('✓ Phase 0 验证通过');
  process.exit(0);
} else {
  console.log('✗ Phase 0 验证失败，请修复上述问题');
  process.exit(1);
}
