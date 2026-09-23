#!/usr/bin/env node
// 发布期 manifest 归一化：把包内所有 `@mebular/*` 内部依赖统一改写为版本号引用（^x.y.z）。
//
// 背景：
//   - 开发期沿用 npm workspaces：packages/fleet、packages/mcp 用 `file:` 链接根包
//     @mebular/core（根包非 workspace 成员，`^x.y.z` 无法被本地命中），`npm ci` 零网络依赖；
//   - 但 `file:` 依赖写进 tarball 后，安装方无法解析。prepack 阶段统一改写为 `^<当前版本>`，
//     postpack 还原，保证“源码本地可链接、tarball 可发布”。
//   - 区间按各内部包 package.json 的当前版本动态计算，故版本升级后无需手改依赖字符串。
//
// 用法：
//   node scripts/publish-manifest.mjs set     [pkgDir]   # prepack：备份并改写
//   node scripts/publish-manifest.mjs restore [pkgDir]   # postpack：还原
//   node scripts/publish-manifest.mjs check   [pkgDir]   # 只读校验：内部依赖是否均为版本号
//
// pkgDir 缺省为当前工作目录（npm 生命周期脚本即在此运行）。

import { existsSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// 内部包名 -> 其源码 package.json 所在目录（相对 repo 根）
const INTERNAL = {
  '@mebular/core': '.',
  '@mebular/fleet': 'packages/fleet',
  '@mebular/mcp': 'packages/mcp',
  '@mebular/service': 'packages/service',
  '@mebular/skill': 'packages/skill',
};

const DEP_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies'];

const command = process.argv[2];
const pkgDir = resolve(process.argv[3] ?? process.cwd());
const pkgFile = join(pkgDir, 'package.json');
const backupFile = `${pkgFile}.packbak`;

const readJson = async (file) => JSON.parse(await readFile(file, 'utf-8'));
const writeJson = async (file, data) => {
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
};

async function internalVersion(name) {
  const rel = INTERNAL[name];
  if (!rel) return undefined;
  return (await readJson(join(repoRoot, rel, 'package.json'))).version;
}

async function rewrite(action) {
  const original = await readFile(pkgFile, 'utf-8');
  const pkg = JSON.parse(original);
  const changed = [];

  for (const field of DEP_FIELDS) {
    const deps = pkg[field];
    if (!deps) continue;
    for (const [name, spec] of Object.entries(deps)) {
      if (!(name in INTERNAL)) continue;
      const version = await internalVersion(name);
      if (!version) continue;
      const range = `^${version}`;
      if (action === 'set' && spec !== range) {
        deps[name] = range;
        changed.push(`${name}: ${spec} -> ${range}`);
      }
      if (action === 'check' && !/^\^?\d+\.\d+\.\d+/.test(String(spec))) {
        throw new Error(`${name} 仍为非版本号引用：${spec}`);
      }
    }
  }

  if (action === 'set' && changed.length > 0) {
    if (!existsSync(backupFile)) await writeFile(backupFile, original, 'utf-8');
    await writeJson(pkgFile, pkg);
  }
  return changed;
}

if (command === 'set') {
  const changed = await rewrite('set');
  if (changed.length > 0) {
    console.error(`[publish-manifest] 已改写内部依赖（备份 ${backupFile}）：\n  ${changed.join('\n  ')}`);
  } else {
    console.error('[publish-manifest] 内部依赖已是版本号引用，无需改写');
  }
} else if (command === 'restore') {
  if (existsSync(backupFile)) {
    await rename(backupFile, pkgFile);
    console.error('[publish-manifest] 已还原源码 manifest');
  }
} else if (command === 'check') {
  try {
    await rewrite('check');
    console.error('[publish-manifest] 内部依赖均为版本号引用');
  } catch (error) {
    console.error(`[publish-manifest] 校验失败：${error.message}`);
    process.exit(1);
  }
} else {
  console.error('用法：node scripts/publish-manifest.mjs set|restore|check [pkgDir]');
  process.exit(2);
}
