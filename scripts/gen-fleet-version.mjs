#!/usr/bin/env node
// 生成 packages/fleet/dist/version.json（构建产物，供 `fleet --version` 打印 commit SHA）。
// SHA 来源：git rev-parse HEAD（从 git 安装/本地构建时可用）；否则 env MEBULAR_BUILD_SHA；否则 unknown。

import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fleetPkg = JSON.parse(readFileSync(join(root, 'packages/fleet/package.json'), 'utf-8'));

function gitSha() {
  if (process.env.MEBULAR_BUILD_SHA) return process.env.MEBULAR_BUILD_SHA;
  try {
    return execSync('git rev-parse HEAD', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'unknown';
  }
}

const out = join(root, 'packages/fleet/dist/version.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  JSON.stringify({ name: fleetPkg.name, version: fleetPkg.version, sha: gitSha(), builtAt: new Date().toISOString() }, null, 2),
  'utf-8',
);
console.log(`wrote ${out} (sha ${gitSha()})`);
