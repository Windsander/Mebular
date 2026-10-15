#!/usr/bin/env node
// 生成构建版本元数据 version.json（供 `--version` 与服务 install 的 sha 解析，F-INSTALL-1）：
//   - packages/fleet/dist/version.json   （fleet --version 打印 commit SHA）
//   - packages/service/dist/version.json （resolveBuildSha 的模块邻接元数据 → sha 与 cwd 解耦，
//                                         npm 全局安装后任意 cwd 都可解析）
// SHA 来源：git rev-parse HEAD（从 git 安装/本地构建时可用）；否则 env MEBULAR_BUILD_SHA；否则 unknown。

import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function gitSha() {
  if (process.env.MEBULAR_BUILD_SHA) return process.env.MEBULAR_BUILD_SHA;
  try {
    return execSync('git rev-parse HEAD', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'unknown';
  }
}

function writeVersion(pkgDir) {
  const pkg = JSON.parse(readFileSync(join(root, pkgDir, 'package.json'), 'utf-8'));
  const out = join(root, pkgDir, 'dist/version.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(
    out,
    JSON.stringify({ name: pkg.name, version: pkg.version, sha: gitSha(), builtAt: new Date().toISOString() }, null, 2),
    'utf-8',
  );
  // 必须走 stderr：build 会作为 `prepare` 在 `npm pack --json` 时执行，stdout 必须是纯 JSON。
  process.stderr.write(`wrote ${out} (sha ${gitSha()})\n`);
}

writeVersion('packages/fleet');
writeVersion('packages/service');
