#!/usr/bin/env node
// Phase 0 验证脚本（纯 JS，无类型标注）

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkFiles } from './verify-lib.mjs';

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
if (!checkFiles(requiredFiles, { indent: '', showSize: true })) {
  allValid = false;
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
