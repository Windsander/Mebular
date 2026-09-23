#!/usr/bin/env node
// G6.5 / D41（fleet 侧）：发布期把本地 `file:` 依赖改写为 registry 范围。
//
// 开发期以 `file:../..`（core）与 `file:../service` 本地链接；prepack 改为 `^0.1.0`，postpack 还原。
// F-UNI：统一 MCP 入口让 `@mebular/mcp` 真的依赖本包，故本包也必须可发布（core + service 一并发布）。
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
const LOCAL_DEPS = ['@mebular/core', '@mebular/service'];

const action = process.argv[2];
const writeJson = (file, data) => writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');

if (action === 'set') {
  const original = await readFile(pkgFile, 'utf-8');
  if (!existsSync(backupFile)) await writeFile(backupFile, original, 'utf-8');
  const pkg = JSON.parse(original);
  pkg.dependencies = pkg.dependencies ?? {};
  for (const dep of LOCAL_DEPS) pkg.dependencies[dep] = PUBLISH_RANGE;
  await writeJson(pkgFile, pkg);
  console.error(`[publish-manifest:fleet] ${LOCAL_DEPS.join(', ')} -> ${PUBLISH_RANGE}（备份 ${backupFile}）`);
} else if (action === 'restore') {
  if (existsSync(backupFile)) {
    await rename(backupFile, pkgFile);
    console.error('[publish-manifest:fleet] 已还原本地 file: 依赖');
  }
} else {
  console.error('用法：node scripts/publish-manifest.mjs set|restore');
  process.exit(2);
}
