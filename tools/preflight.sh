#!/bin/bash
# The app gate: build it, then prove the things that break silently. Must pass before every commit lands.
#   tools/preflight.sh        build + every check
#   tools/preflight.sh --ci   same, for CI (no .env there, so the bundle is checked by pattern only)
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
fail=0
ok()  { echo "✓ $1"; }
bad() { echo "✗ $1"; echo "    FIX: $2"; fail=1; }
APP=build/app.noindex/Forge.app
BIN="$APP/Contents/MacOS/Forge"

echo "Build"
if ./build.sh; then ok "Forge.app builds"; else bad "build failed" "read the swiftc error above"; echo "preflight: FAILED"; exit 1; fi

echo; echo "Bundle"
V=$(tr -d ' \n' < VERSION)
PV=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist" 2>/dev/null)
[ "$PV" = "$V" ] && ok "version $V matches VERSION" || bad "Info.plist says '$PV', VERSION says '$V'" "build.sh writes VERSION into Info.plist; don't hardcode it"
for f in LICENSE NOTICE; do
  [ -f "$APP/Contents/Resources/$f" ] && ok "$f ships inside the app" || bad "$f missing from the app" "build.sh must copy LICENSE and NOTICE (Apache-2.0 requires them)"
done
if grep -rIl -E 'lin_api_|sk-ant-|github_pat_|ghp_|PRIVATE KEY' "$APP" >/dev/null 2>&1; then
  bad "something that looks like a secret is inside the app" "secrets come from the Keychain at run time, never the bundle"
else ok "no secrets in the app"; fi
if [ -f .env ]; then
  leaked=0
  while IFS= read -r v; do [ ${#v} -ge 4 ] && grep -rIqF "$v" "$APP" && leaked=1; done < <(sed -n 's/^[A-Z_]*=//p' .env | sed -e 's/^"//' -e 's/"$//')
  [ "$leaked" = 0 ] && ok "no .env value inside the app" || bad "a value from .env is inside the app" "identity and keys come from env or the Keychain, never the bundle"
fi

echo; echo "App"
if "$BIN" --selftest; then ok "selftest"; else bad "selftest failed" "see the ✗ lines above"; fi
OUT=$(mktemp -t forge-window-check)
rm -f "$OUT"
"$BIN" --window-check "$OUT" >/dev/null 2>&1 &
PID=$!
for _ in $(seq 1 40); do [ -s "$OUT" ] && break; sleep 0.25; done
kill "$PID" 2>/dev/null
if grep -q '^ok' "$OUT" 2>/dev/null; then ok "the app opens a window titled Forge"; else bad "no window titled Forge ($(cat "$OUT" 2>/dev/null))" "the main scene is Window(AppInfo.name, ...) in Sources/App/ForgeApp.swift"; fi
rm -f "$OUT"

echo; echo "Guardrails"
if python3 tools/lint/forge-lint.py --prove >/dev/null; then ok "every lint rule blocks its planted violation"; else bad "a lint rule let its canary through" "run tools/lint/forge-lint.py --prove"; fi

echo
[ "$fail" = 0 ] && echo "preflight: all passed" || echo "preflight: FAILED"
exit $fail
