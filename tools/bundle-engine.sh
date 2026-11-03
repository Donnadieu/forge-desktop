#!/bin/bash
# Puts the engine inside the app: the pinned Node, the engine's compiled JS and its production
# packages. Called by build.sh.
#   tools/bundle-engine.sh <Forge.app/Contents/Resources/engine>
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
DEST="$1"
NODE=$(tools/fetch-node.sh)
command -v pnpm >/dev/null || { echo "bundle-engine: pnpm isn't on PATH. FIX: brew install pnpm (or mise install)." >&2; exit 1; }
tools/engine.sh pnpm install --frozen-lockfile --silent >/dev/null
rm -rf engine/dist
tools/engine.sh pnpm run --silent build >/dev/null
# Production packages only, laid flat (no links), cached per lockfile.
LOCK=$(shasum -a 256 engine/pnpm-lock.yaml engine/package.json | shasum -a 256 | cut -c1-16)
PROD="build/cache/engine-prod-$LOCK"
if [ ! -d "$PROD/node_modules" ]; then
  rm -rf "$PROD" && mkdir -p "$PROD"
  cp engine/package.json engine/pnpm-lock.yaml "$PROD/"
  ( cd "$PROD" && PATH="$(dirname "$NODE"):$PATH" pnpm install --prod --frozen-lockfile --silent \
      --config.node-linker=hoisted --ignore-scripts >/dev/null )
fi
rm -rf "$DEST" && mkdir -p "$DEST"
cp "$NODE" "$DEST/node"
cp "$(dirname "$NODE")/../LICENSE" "$DEST/NODE-LICENSE"
cp -R engine/dist "$DEST/dist"
cp -R "$PROD/node_modules" "$DEST/node_modules"
cp engine/package.json "$DEST/package.json"
find "$DEST/dist" -name '*.map' -delete
echo "engine bundled ($(du -sh "$DEST" | cut -f1))"
