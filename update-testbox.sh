#!/usr/bin/env bash
#
# update-testbox.sh — update a deepfreeze test box to the latest branch tip,
# rebuild the React frontend, deploy it for the running server, and restart.
#
# Safe to re-run. Handles the common "untracked package-lock.json blocks the
# pull" case, and deploys correctly whether deepfreeze-server is installed as an
# editable checkout (pip install -e) or a built wheel (pip install).
#
# Usage:
#   ./update-testbox.sh                 # uses the defaults below
#   REPO_DIR=/srv/deepfreeze ./update-testbox.sh
#   BRANCH=dev SERVICE=deepfreeze-server PYTHON=/home/deepfreeze/.pyenv/shims/python ./update-testbox.sh
#   SERVICE= ./update-testbox.sh        # skip the systemd restart (manual run)
#
set -euo pipefail

# --- configuration (override via environment) ---
REPO_DIR="${REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
BRANCH="${BRANCH:-dev}"
SERVICE="${SERVICE:-deepfreeze-server}"   # systemd unit; set empty to skip restart
# Interpreter for the environment the SERVER runs in. The systemd unit uses the
# pyenv shim, so default to that and fall back to python3 on PATH.
PYTHON="${PYTHON:-/home/deepfreeze/.pyenv/shims/python}"
command -v "$PYTHON" >/dev/null 2>&1 || PYTHON="$(command -v python3 || command -v python)"

PKG_DIR="$REPO_DIR/packages/deepfreeze-server"
FRONTEND_DIR="$PKG_DIR/frontend"
REPO_PKG_DIR="$PKG_DIR/deepfreeze_server"

say() { printf '\n==> %s\n' "$*"; }

cd "$REPO_DIR"

# --- 1. Update the checkout ---------------------------------------------------
say "Fetching origin and checking out '$BRANCH' in $REPO_DIR"
git fetch origin
git checkout "$BRANCH"

# Move aside any untracked file that the incoming commits now track (it would
# otherwise abort the merge). package-lock.json is the usual culprit.
say "Checking for untracked files that would block a fast-forward"
BLOCKERS="$(git diff --name-only --diff-filter=A "HEAD..origin/$BRANCH" | while read -r f; do
  if [ -e "$f" ] && ! git ls-files --error-unmatch "$f" >/dev/null 2>&1; then
    printf '%s\n' "$f"
  fi
done)"
if [ -n "$BLOCKERS" ]; then
  BAK="/tmp/deepfreeze-untracked-$(date +%Y%m%d-%H%M%S)"
  echo "    Found collisions; moving them to $BAK (in case you need them back):"
  printf '%s\n' "$BLOCKERS" | while read -r f; do
    mkdir -p "$BAK/$(dirname "$f")"
    mv "$f" "$BAK/$f"
    echo "      $f"
  done
fi

git pull --ff-only origin "$BRANCH"
echo "    Now at: $(git rev-parse --short HEAD) $(git log -1 --pretty=%s)"

# --- 2. Rebuild the frontend --------------------------------------------------
say "Building frontend (npm ci && npm run build)"
cd "$FRONTEND_DIR"
npm ci
npm run build   # outputs to frontend/dist/

# --- 3. Deploy the build for the running server -------------------------------
# Figure out which deepfreeze_server the server actually imports, so we know
# whether a checkout rebuild is enough (editable) or a reinstall is required
# (wheel installed into site-packages).
say "Locating the installed deepfreeze_server package"
INSTALLED_PKG="$("$PYTHON" -c 'import deepfreeze_server, os; print(os.path.realpath(os.path.dirname(deepfreeze_server.__file__)))' 2>/dev/null || true)"
REPO_PKG_REAL="$(cd "$REPO_PKG_DIR" && pwd -P)"
echo "    server python : $PYTHON"
echo "    imports from  : ${INSTALLED_PKG:-<not importable>}"
echo "    repo package  : $REPO_PKG_REAL"

# app.py serves <package>/static if present, else ../frontend/dist. Refresh the
# checkout's static/ from the fresh dist/ so it is deterministic and not stale.
say "Refreshing $REPO_PKG_DIR/static from frontend/dist"
rm -rf "$REPO_PKG_DIR/static"
cp -r "$FRONTEND_DIR/dist" "$REPO_PKG_DIR/static"

if [ "$INSTALLED_PKG" = "$REPO_PKG_REAL" ]; then
  echo "    Editable install detected — refreshed static/ is already live."
elif [ -n "$INSTALLED_PKG" ]; then
  say "Wheel install detected — reinstalling so the bundled static updates"
  "$PYTHON" -m pip install "$PKG_DIR"
else
  echo "    WARNING: could not import deepfreeze_server with '$PYTHON'."
  echo "    If the server runs under a different env, set PYTHON=<that python> and re-run,"
  echo "    or reinstall manually:  <server-python> -m pip install $PKG_DIR"
fi

# --- 4. Restart the service ---------------------------------------------------
if [ -n "$SERVICE" ] && command -v systemctl >/dev/null 2>&1 \
   && systemctl list-unit-files 2>/dev/null | grep -q "^$SERVICE\.service"; then
  say "Restarting $SERVICE"
  sudo systemctl restart "$SERVICE"
  sleep 2
  systemctl --no-pager --lines=10 status "$SERVICE" || true
else
  say "Skipping restart"
  echo "    No '$SERVICE' systemd unit found (or SERVICE empty)."
  echo "    Restart the server manually so it picks up the new frontend."
fi

say "Done."
