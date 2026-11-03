#!/bin/bash
# Runs a command in engine/ with Node 22 and pnpm (from PATH, else mise's Node 22, else `mise exec`).
#   tools/engine.sh pnpm install --frozen-lockfile
#   tools/engine.sh pnpm run check
set -euo pipefail
cd "$(git rev-parse --show-toplevel)/engine"
if ! command -v node >/dev/null 2>&1; then
  MISE_NODE="${MISE_DATA_DIR:-$HOME/.local/share/mise}/installs/node/22/bin"
  [ -x "$MISE_NODE/node" ] && PATH="$MISE_NODE:$PATH"
fi
if command -v node >/dev/null 2>&1 && command -v pnpm >/dev/null 2>&1; then
  exec "$@"
elif command -v mise >/dev/null 2>&1; then
  exec mise exec -- "$@"
fi
echo "engine: Node 22 and pnpm aren't installed." >&2
echo "FIX: brew install mise && mise install (reads .mise.toml), or put node 22 + pnpm on PATH." >&2
exit 1
