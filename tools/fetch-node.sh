#!/bin/bash
# Prints the path of the pinned Node the app bundles, downloading it once into build/cache.
# The version and its SHA-256 live in engine/node-version.txt; a download that doesn't match is refused.
#   tools/fetch-node.sh        -> build/cache/node-v<version>-darwin-arm64/bin/node
set -euo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || dirname "$0"/..)"
read -r VERSION SHA < engine/node-version.txt
NAME="node-v$VERSION-darwin-arm64"
CACHE=build/cache
BIN="$CACHE/$NAME/bin/node"
if [ -x "$BIN" ]; then echo "$BIN"; exit 0; fi
mkdir -p "$CACHE"
TGZ="$CACHE/$NAME.tar.gz"
curl -fsSL --retry 3 -o "$TGZ.part" "https://nodejs.org/dist/v$VERSION/$NAME.tar.gz"
GOT=$(shasum -a 256 "$TGZ.part" | cut -d' ' -f1)
if [ "$GOT" != "$SHA" ]; then
  rm -f "$TGZ.part"
  echo "fetch-node: $NAME.tar.gz has SHA-256 $GOT, expected $SHA" >&2
  echo "FIX: if Node was bumped on purpose, put the new version and its SHA from nodejs.org/dist/v<version>/SHASUMS256.txt in engine/node-version.txt" >&2
  exit 1
fi
mv "$TGZ.part" "$TGZ"
tar -xzf "$TGZ" -C "$CACHE" "$NAME/bin/node" "$NAME/LICENSE"
rm -f "$TGZ"
echo "$BIN"
