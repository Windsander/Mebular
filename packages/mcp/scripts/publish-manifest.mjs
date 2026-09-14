#!/usr/bin/env node
// G6.5 / D41：發布期改寫 @mebular/core 依賴。
//
// 開發期以 `file:../..` 本地連結（根包非 workspace 成員、本環境 npm 不支援 `workspace:`）；
// `npm pack`/`npm publish` 的 prepack 階段改為 `^0.1.0`，postpack 還原。
//
// 用法：node scripts/publish-manifest.mjs set|restore

import { existsSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgFile = join(pkgDir, 'package.json');
const backupFile = `${pkgFile}.packbak`;
const PUBLISH_RANGE = '^0.1.0';

const action = process.argv[2];

async function writeJson(file, data) {
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
}

if (action === 'set') {
  const original = await readFile(pkgFile, 'utf-8');
  if (!existsSync(backupFile)) await writeFile(backupFile, original, 'utf-8');
  const pkg = JSON.parse(original);
  pkg.dependencies = pkg.dependencies ?? {};
  pkg.dependencies['@mebular/core'] = PUBLISH_RANGE;
  await writeJson(pkgFile, pkg);
  console.error(`[publish-manifest] @mebular/core -> ${PUBLISH_RANGE}（備份 ${backupFile}）`);
} else if (action === 'restore') {
  if (existsSync(backupFile)) {
    await rename(backupFile, pkgFile);
    console.error('[publish-manifest] 已還原本地 file: 依賴');
  }
} else {
  console.error('用法：node scripts/publish-manifest.mjs set|restore');
  process.exit(2);
}
