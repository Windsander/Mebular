// 构建 SHA 解析（F-INSTALL-1：**与 cwd 解耦**）。
//
// 病灶：旧 `resolveBuildSha()` 默认 `git rev-parse HEAD` 于 `process.cwd()`——全局安装的
// `mebular service install` 在仓库目录外执行时 sha=unknown，在仓库内执行才是真实 sha。
// 本模块是 ESM 边界（.mjs，不经 ts-jest），可安全用 import.meta 定位**安装自身**：
//
//   1. env 覆盖（MEBULAR_BUILD_SHA / MEBULAR_SERVICE_SHA）；
//   2. 模块邻接构建元数据 `packages/service/dist/version.json`（构建期由
//      scripts/gen-fleet-version.mjs 写入；npm 全局安装 `@mebular/core` 后依然在包内）；
//   3. 模块所在仓库的 git HEAD（仓库内直跑兜底；全局安装不是 git 仓库 → 跳过）；
//   4. `unknown`。
//
// 三种来源均与调用者的 cwd 无关。

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function serviceBuildSha(env = process.env) {
  const fromEnv = env.MEBULAR_BUILD_SHA ?? env.MEBULAR_SERVICE_SHA;
  if (fromEnv) return fromEnv;
  // packages/mcp/src/build-sha.mjs → packages/service/dist/version.json（同一 @mebular/core 包内）
  try {
    const meta = JSON.parse(readFileSync(new URL('../../service/dist/version.json', import.meta.url), 'utf-8'));
    if (typeof meta.sha === 'string' && meta.sha.length > 0 && meta.sha !== 'unknown') return meta.sha;
  } catch {
    // 无构建元数据（未构建）→ 继续
  }
  // packages/mcp/src/build-sha.mjs → 包根（仓库检出时为 git 仓库根）
  try {
    const pkgRoot = fileURLToPath(new URL('../../..', import.meta.url));
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: pkgRoot, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'unknown';
  }
}
