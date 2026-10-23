#!/usr/bin/env bash
# 一键同步版本号（lockstep：5 个可发布包共用同一版本）。
#
#   bash scripts/bump_version.sh v0.2.0
#
# 同步内容：
#   1. package.json × 5（root @mebular/core + fleet / mcp / service / skill）的 version；
#   2. 这些 manifest 中任何“已是版本号区间”的内部 @mebular/* 依赖 -> ^<new version>
#      （源码开发期使用 file: 本地链接，pack 期由 scripts/publish-manifest.mjs 统一改写为
#       ^<version>，故 file: 依赖保持不动、无需在此改写）；
#   3. apps/desktop/package.json（桌面 App 与 npm 包 lockstep）+ package-lock 根 version
#      + src/main/daemon.mjs 的 APP_VERSION（打包态 / 诊断共用）；
#   4. CHANGELOG.md 插入 `## [vX.Y.Z] - <date>` 章节占位（幂等，已存在则跳过）。
#
# 发布分支命名（版本 SSOT）：release/vX.Y.Z，工作流据此校验版本一致。

set -euo pipefail

usage() {
  echo "用法：bash scripts/bump_version.sh v0.2.0"
  echo "（也接受不带 v 的 0.2.0）"
}

if [ "${1:-}" = "" ] || [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  [ "${1:-}" = "" ] && exit 2 || exit 0
fi

RAW="$1"
VERSION="${RAW#v}"
TAG="v${VERSION}"

if ! printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$'; then
  echo "错误：版本号格式非法：$RAW（期望形如 v0.2.0）" >&2
  usage >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATE="$(date -u +%Y-%m-%d)"
export REPO_ROOT VERSION TAG DATE

node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const root = process.env.REPO_ROOT;
const version = process.env.VERSION;
const tag = process.env.TAG;
const date = process.env.DATE;

const TARGETS = [
  '.',
  'packages/fleet',
  'packages/mcp',
  'packages/service',
  'packages/skill',
  'apps/desktop',
];
const INTERNAL = new Set([
  '@mebular/core',
  '@mebular/fleet',
  '@mebular/mcp',
  '@mebular/service',
  '@mebular/skill',
]);
const DEP_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies'];
const IS_VERSION_RANGE = /^\^?\d+\.\d+\.\d+/;

let changedDeps = 0;
for (const rel of TARGETS) {
  const file = path.join(root, rel, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  pkg.version = version;
  for (const field of DEP_FIELDS) {
    const deps = pkg[field];
    if (!deps) continue;
    for (const [name, spec] of Object.entries(deps)) {
      if (!INTERNAL.has(name)) continue;
      // 仅同步已成为版本号区间的内部依赖；file:/workspace: 留给本地 workspace / pack 期改写。
      if (IS_VERSION_RANGE.test(String(spec))) {
        deps[name] = `^${version}`;
        changedDeps += 1;
      }
    }
  }
  fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  console.log(`  version -> ${version}  ${rel === '.' ? '@mebular/core' : rel}`);
}

// ---- 桌面 App：package-lock 根 version + main 进程 APP_VERSION ----
const desktopLockFile = path.join(root, 'apps/desktop/package-lock.json');
if (fs.existsSync(desktopLockFile)) {
  const lock = JSON.parse(fs.readFileSync(desktopLockFile, 'utf8'));
  const rootEntry = lock.packages?.[''] ?? null;
  const lockChanged = lock.version !== version || (rootEntry !== null && rootEntry.version !== version);
  lock.version = version;
  if (rootEntry !== null) rootEntry.version = version;
  if (lockChanged) {
    fs.writeFileSync(desktopLockFile, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
    console.log(`  version -> ${version}  apps/desktop/package-lock.json`);
  }
}

const desktopDaemon = path.join(root, 'apps', 'desktop', 'src', 'main', 'daemon.mjs');
if (fs.existsSync(desktopDaemon)) {
  const before = fs.readFileSync(desktopDaemon, 'utf8');
  const after = before.replace(
    /(export const APP_VERSION = ')[^']+(';)/,
    `$1${version}$2`,
  );
  if (after === before) {
    if (!/export const APP_VERSION = '/.test(before)) {
      console.error('ERROR: apps/desktop/src/main/daemon.mjs 缺少 APP_VERSION 导出');
      process.exit(1);
    }
    console.log(`  APP_VERSION 已是 ${version}，跳过`);
  } else {
    fs.writeFileSync(desktopDaemon, after, 'utf8');
    console.log(`  APP_VERSION -> ${version}  apps/desktop/src/main/daemon.mjs`);
  }
}

// ---- CHANGELOG 章节占位 ----
const clFile = path.join(root, 'CHANGELOG.md');
const HEADER =
  '# Changelog\n\nAll notable changes to Mebular are documented here.\nAll published packages share a single lockstep version.\n';
let text = fs.existsSync(clFile) ? fs.readFileSync(clFile, 'utf8') : HEADER;

if (new RegExp(`^## \\[${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`, 'm').test(text)) {
  console.log(`  CHANGELOG 已存在 [${tag}] 章节，跳过`);
} else {
  const block =
    `## [${tag}] - ${date}\n\n` +
    '### Added\n\n- _TODO_\n\n' +
    '### Changed\n\n- _TODO_\n\n' +
    '### Fixed\n\n- _TODO_\n';
  const lines = text.split('\n');
  const idx = lines.findIndex((line) => line.startsWith('## ['));
  if (idx === -1) {
    text = `${text.replace(/\s*$/, '')}\n\n${block}\n`;
  } else {
    // 在首个 `## [` 之前插入新章节，并保留与旧章节之间的空行。
    lines.splice(idx, 0, block.replace(/\n$/, ''), '');
    text = lines.join('\n');
  }
  fs.writeFileSync(clFile, text, 'utf8');
  console.log(`  CHANGELOG 新增 [${tag}] 章节占位`);
}

console.log(`  内部依赖版本号同步：${changedDeps} 处（file: 本地依赖由 pack 期改写）`);
NODE

echo "✓ 已同步为 ${TAG}（5 个 npm 包 + 桌面 App + CHANGELOG；请填写章节内容后提交，并将分支命名为 release/${TAG}）"
