#!/usr/bin/env node
// 發布期改寫 @mebular/core / @mebular/fleet 依賴。
//
// 開發期以 `file:../..` 本地連結（根包非 workspace 成員、本環境 npm 不支援 `workspace:`）；
// `npm pack`/`npm publish` 的 prepack 階段改為 `^<本包 package.json version>`，postpack 還原。
// 版本區間從 package.json 讀取，不在腳本內硬編碼；升級版本只需跑 scripts/bump_version.sh。
//
// 用法：node scripts/publish-manifest.mjs set|restore

import { existsSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgFile = join(pkgDir, 'package.json');
const backupFile = `${pkgFile}.packbak`;

const action = process.argv[2];

async function writeJson(file, data) {
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
}

if (action === 'set') {
  const original = await readFile(pkgFile, 'utf-8');
  const pkg = JSON.parse(original);
  const publishRange = `^${pkg.version}`;
  if (!existsSync(backupFile)) await writeFile(backupFile, original, 'utf-8');
  pkg.dependencies = pkg.dependencies ?? {};
  // F-UNI：統一入口复用 fleet 的任務 handler/令牌原語 → 發布時一併宣告
  for (const dep of ['@mebular/core', '@mebular/fleet']) {
    if (pkg.dependencies[dep] !== undefined) pkg.dependencies[dep] = publishRange;
  }
  await writeJson(pkgFile, pkg);
  console.error(`[publish-manifest] @mebular/{core,fleet} -> ${publishRange}（備份 ${backupFile}）`);
} else if (action === 'restore') {
  if (existsSync(backupFile)) {
    await rename(backupFile, pkgFile);
    console.error('[publish-manifest] 已還原本地 file: 依賴');
  }
} else {
  console.error('用法：node scripts/publish-manifest.mjs set|restore');
  process.exit(2);
}
