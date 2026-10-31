#!/bin/sh
# Install the Mebular Hermes plugins from the release bundle.
#
# Usage:
#   HERMES_HOME="$HOME/.hermes" ./install.sh
#
# The bundle layout is:
#   mebular/                 memory provider (directory name == memory.provider)
#   mebular-companion/       optional standalone plugin
#   install.sh
#   README.md
#   VERSION
#
# The memory provider must be installed as plugins/mebular. Hermes discovers
# providers by directory name, so plugins/mebular-memory would require
# `memory.provider: mebular-memory` even though provider.name is `mebular`.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
HERMES_HOME=${HERMES_HOME:-"$HOME/.hermes"}
PLUGINS_DIR="$HERMES_HOME/plugins"

SOURCE_MEMORY="$SCRIPT_DIR/mebular"
SOURCE_COMPANION="$SCRIPT_DIR/mebular-companion"
TARGET_MEMORY="$PLUGINS_DIR/mebular"
TARGET_COMPANION="$PLUGINS_DIR/mebular-companion"

STAGING=""
BACKUP_MEMORY=""
BACKUP_COMPANION=""
INSTALLED_MEMORY=0
INSTALLED_COMPANION=0
COMMITTED=0

fail() {
  printf 'mebular install: %s\n' "$*" >&2
  exit 1
}

rollback() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$COMMITTED" -ne 1 ]; then
    if [ "$INSTALLED_COMPANION" -eq 1 ]; then
      rm -rf "$TARGET_COMPANION"
    fi
    if [ "$INSTALLED_MEMORY" -eq 1 ]; then
      rm -rf "$TARGET_MEMORY"
    fi
    if [ -n "$BACKUP_COMPANION" ] && [ -e "$BACKUP_COMPANION" ]; then
      mv "$BACKUP_COMPANION" "$TARGET_COMPANION" 2>/dev/null || true
    fi
    if [ -n "$BACKUP_MEMORY" ] && [ -e "$BACKUP_MEMORY" ]; then
      mv "$BACKUP_MEMORY" "$TARGET_MEMORY" 2>/dev/null || true
    fi
    printf 'mebular install: failed; previous plugin directories were restored\n' >&2
  fi
  if [ -n "$STAGING" ]; then
    rm -rf "$STAGING"
  fi
  exit "$status"
}

trap 'rollback' EXIT
trap 'exit 130' HUP INT TERM

[ -d "$SOURCE_MEMORY" ] || fail "missing $SOURCE_MEMORY"
[ -f "$SOURCE_MEMORY/__init__.py" ] || fail "missing $SOURCE_MEMORY/__init__.py"
[ -f "$SOURCE_MEMORY/plugin.yaml" ] || fail "missing $SOURCE_MEMORY/plugin.yaml"
[ -d "$SOURCE_COMPANION" ] || fail "missing $SOURCE_COMPANION"
[ -f "$SOURCE_COMPANION/__init__.py" ] || fail "missing $SOURCE_COMPANION/__init__.py"
[ -f "$SOURCE_COMPANION/plugin.yaml" ] || fail "missing $SOURCE_COMPANION/plugin.yaml"

mkdir -p "$PLUGINS_DIR" || fail "cannot create $PLUGINS_DIR"

# Stage both plugins next to their destinations first, so a copy failure never
# leaves a half-installed provider behind.
STAGING="$PLUGINS_DIR/.mebular-install.$$"
rm -rf "$STAGING"
mkdir -p "$STAGING" || fail "cannot create staging directory"
cp -R "$SOURCE_MEMORY" "$STAGING/mebular" || fail "cannot copy the memory provider"
cp -R "$SOURCE_COMPANION" "$STAGING/mebular-companion" || fail "cannot copy the companion"

# A source checkout may contain local test artifacts; never install them.
find "$STAGING" -type d -name '__pycache__' -prune -exec rm -rf {} + 2>/dev/null || true
find "$STAGING" -type f \( -name '*.pyc' -o -name '*.pyo' \) -exec rm -f {} + 2>/dev/null || true

[ -f "$STAGING/mebular/plugin.yaml" ] || fail "staged memory provider is incomplete"
[ -f "$STAGING/mebular-companion/plugin.yaml" ] || fail "staged companion is incomplete"

backup_dir() {
  target="$1"
  if [ ! -e "$target" ] && [ ! -L "$target" ]; then
    return 0
  fi
  stamp=$(date -u +%Y%m%d-%H%M%S)
  candidate="${target}.bak-${stamp}"
  suffix=1
  while [ -e "$candidate" ] || [ -L "$candidate" ]; do
    candidate="${target}.bak-${stamp}-${suffix}"
    suffix=$((suffix + 1))
  done
  mv "$target" "$candidate" || return 1
  printf '%s\n' "$candidate"
}

BACKUP_MEMORY=$(backup_dir "$TARGET_MEMORY") || fail "cannot back up $TARGET_MEMORY"
BACKUP_COMPANION=$(backup_dir "$TARGET_COMPANION") || fail "cannot back up $TARGET_COMPANION"

mv "$STAGING/mebular" "$TARGET_MEMORY" || fail "cannot install the memory provider"
INSTALLED_MEMORY=1
mv "$STAGING/mebular-companion" "$TARGET_COMPANION" || fail "cannot install the companion"
INSTALLED_COMPANION=1

COMMITTED=1
rm -rf "$STAGING"

printf '\nMebular Hermes plugins installed.\n'
printf '  memory provider: %s\n' "$TARGET_MEMORY"
printf '  companion:       %s\n' "$TARGET_COMPANION"
if [ -n "$BACKUP_MEMORY" ]; then
  printf '  previous provider backed up to: %s\n' "$BACKUP_MEMORY"
fi
if [ -n "$BACKUP_COMPANION" ]; then
  printf '  previous companion backed up to: %s\n' "$BACKUP_COMPANION"
fi

printf '\nNext step (activate the memory provider):\n'
printf '  hermes config set memory.provider mebular\n'
printf '\nOptional companion (disabled by default):\n'
printf '  hermes plugins enable mebular-companion\n'
printf '  export MEBULAR_COMPANION_ENABLED=1\n'
printf '\nRestart Hermes or start a new session after changing memory.provider.\n'
printf 'Hermes built-in MEMORY.md / USER.md are not imported, mirrored, or modified.\n'
