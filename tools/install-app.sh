#!/bin/bash
# Installs the built app as /Applications/Forge.app. Quits a running Forge first (it drains its agents on quit).
# Touches nothing but Forge.
set -euo pipefail
APP="$1"
[ -d "$APP/Contents/MacOS" ] || { echo "no app at $APP" >&2; exit 1; }
for pid in $(pgrep -f "/Applications/Forge.app/Contents/MacOS/Forge" || true); do
  kill "$pid" 2>/dev/null || true
done
for _ in $(seq 1 30); do pgrep -f "/Applications/Forge.app/Contents/MacOS/Forge" >/dev/null || break; sleep 1; done
rm -rf /Applications/Forge.app.new
ditto "$APP" /Applications/Forge.app.new
rm -rf /Applications/Forge.app
mv /Applications/Forge.app.new /Applications/Forge.app
echo "installed /Applications/Forge.app"
