#!/usr/bin/env bash
# Mirror this plugin's source into a sibling Kibana checkout so Kibana's
# tooling (tsc, jest, FTR, dev-server) can see it as an in-tree plugin.
#
# Why rsync rather than a symlink? Kibana's plugin discovery uses
# `git ls-files` from the Kibana repo root. git treats a symlink as a
# single entry and does NOT descend into it — so the kibana.jsonc inside
# a symlinked plugin directory is invisible to discovery. An rsync'd
# real directory is discovered correctly.
#
# Usage:
#   scripts/sync-to-kibana.sh [path-to-kibana-checkout]
#
# Default Kibana location: ~/git/kibana
# Override with $KIBANA_DIR or by passing a positional argument.

set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KIBANA_DIR="${1:-${KIBANA_DIR:-$HOME/git/kibana}}"
TARGET="$KIBANA_DIR/x-pack/platform/plugins/private/deepfreeze"

if [[ ! -d "$KIBANA_DIR" ]]; then
  echo "Kibana checkout not found at: $KIBANA_DIR" >&2
  echo "Set KIBANA_DIR or pass the path as the first argument." >&2
  exit 1
fi

# If a stale symlink is in place from an earlier setup attempt, remove it.
if [[ -L "$TARGET" ]]; then
  rm "$TARGET"
fi

mkdir -p "$TARGET"

rsync -a --delete \
  --exclude=node_modules \
  --exclude=target \
  --exclude=.git \
  "$PLUGIN_DIR/" \
  "$TARGET/"

echo "Synced $PLUGIN_DIR → $TARGET"
echo
echo "If this is the first sync after adding new manifest entries, run:"
echo "  cd $KIBANA_DIR && yarn kbn bootstrap --force-install"
echo
echo "Otherwise type-check from the Kibana checkout:"
echo "  cd $KIBANA_DIR && node scripts/type_check --project x-pack/platform/plugins/private/deepfreeze/tsconfig.json"
