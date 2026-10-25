#!/usr/bin/env bash
# 一键同步版本号（lockstep：6 个可发布包共用同一版本）。
#
#   bash scripts/bump_version.sh v0.2.0
#
# 具体改写逻辑在 scripts/bump-version.mjs（可被测试直接 import）：
#   1. package.json × 6（root @mebular/core + fleet / mcp / service / skill / dsh-plugin）；
#   2. 这些 manifest 中“已是版本号区间”的内部 @mebular/* 依赖 -> ^<new version>；
#   3. 根 package-lock.json 与 apps/desktop/package-lock.json；
#   4. apps/desktop/src/main/daemon.mjs 的 APP_VERSION；
#   5. packages/mcp/src/version.mjs（MCP 对外版本唯一真源）；
#   6. CHANGELOG.md 插入 `## [vX.Y.Z] - <date>` 章节占位（幂等）。
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

node "$REPO_ROOT/scripts/bump-version.mjs" \
  --root "$REPO_ROOT" \
  --version "$VERSION" \
  --tag "$TAG" \
  --date "$DATE"

echo "请填写 CHANGELOG 章节内容后提交，并将分支命名为 release-prep/${TAG}（dry-run 通过后再创建 release/${TAG}）"
