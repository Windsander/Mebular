#!/usr/bin/env node
// F-HYGIENE-1：构建后补回 bin 入口的可执行位（固化进构建/prepare 链路）。
//
// 根因：`packages/fleet/dist/cli.js` 由 tsc 生成 → 无 +x；而 `npm i -g .` 的 prepare
// 会**再跑一次 build**，随之覆盖安装前手工 `chmod +x` 的结果 → 裸 `fleet` 报
// `permission denied`。因此把 +x 放在**构建的最后一步**，让 prepare（=build）自身保证它。
//
// 覆盖：根 package.json 的 `bin` + 各 workspace 包的 `bin`（本仓为 packages/fleet）。
// 仅用 Node 内建 fs（Windows/Linux/macOS 通用）；Windows 上 chmod 近似无效，忽略失败。

import { chmodSync, existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 取某 package.json 的 bin 目标（字符串或对象），解析为绝对路径。 */
function binTargets(manifestPath, baseDir) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  } catch {
    return [];
  }
  const bin = pkg.bin;
  const raw = typeof bin === 'string' ? [bin] : bin && typeof bin === 'object' ? Object.values(bin) : [];
  return raw.filter((p) => typeof p === 'string').map((p) => join(baseDir, p));
}

const targets = new Set([
  ...binTargets(join(ROOT, 'package.json'), ROOT),
  ...binTargets(join(ROOT, 'packages', 'fleet', 'package.json'), join(ROOT, 'packages', 'fleet')),
]);

let changed = 0;
for (const file of targets) {
  if (!existsSync(file)) continue;
  if ((statSync(file).mode & 0o777) === 0o755) continue;
  try {
    chmodSync(file, 0o755);
    changed += 1;
    console.log(`[chmod-bins] +x ${relative(ROOT, file)}`);
  } catch (error) {
    console.warn(`[chmod-bins] 跳过 ${relative(ROOT, file)}：${String(error?.message ?? error)}`);
  }
}
console.log(`[chmod-bins] 完成（${targets.size} 个入口，补 +x ${changed} 个）`);
