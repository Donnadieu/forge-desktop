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
# Real keys are long; the engine's own code has short look-alikes (a prefix table), which are fine.
# A real PEM key has its BEGIN header alone on a line; code that checks for one quotes it.
if grep -rIl -E 'lin_api_[A-Za-z0-9]{32}|sk-ant-[A-Za-z0-9_-]{60}|github_pat_[A-Za-z0-9_]{40}|ghp_[A-Za-z0-9]{30}|^-----BEGIN [A-Z ]*PRIVATE KEY-----$' "$APP" >/dev/null 2>&1; then
  bad "something that looks like a secret is inside the app" "secrets come from the Keychain at run time, never the bundle"
else ok "no secrets in the app"; fi
if [ -f .env ]; then
  leaked=0
  while IFS= read -r v; do [ ${#v} -ge 4 ] && grep -rIqF "$v" "$APP" && leaked=1; done < <(sed -n 's/^[A-Z_]*=//p' .env | sed -e 's/^"//' -e 's/"$//')
  [ "$leaked" = 0 ] && ok "no .env value inside the app" || bad "a value from .env is inside the app" "identity and keys come from env or the Keychain, never the bundle"
fi

echo; echo "App"
# The selftest runs as FORGE_SELFTEST_PARTS shares side by side (3: one per core of GitHub's Mac); each share's lines
# print in order once all have ended, with its time and the slowest groups. One share alone: Forge --selftest --part 2/3.
PARTS=${FORGE_SELFTEST_PARTS:-3}
ST=$(mktemp -d -t forge-selftest)
pids=()
for k in $(seq 1 "$PARTS"); do
  FORGE_SELFTEST_TIMES=1 "$BIN" --selftest --part "$k/$PARTS" >"$ST/$k.out" 2>"$ST/$k.err" &
  pids+=($!)
done
st_fail=0
for k in $(seq 1 "$PARTS"); do
  wait "${pids[$((k - 1))]}" || st_fail=1
  echo "selftest share $k/$PARTS:"
  cat "$ST/$k.out"
  grep -v '^⏱' "$ST/$k.err" | grep -v 'IOServiceMatching' || true
done
grep -h '^⏱ total' "$ST"/*.err | sed 's/^⏱ total/  share took/'
grep -h '^⏱' "$ST"/*.err | grep -v '^⏱ total' | sort -k3 -n -r | head -5 | sed 's/^⏱/  slowest group:/'
rm -rf "$ST"
if [ "$st_fail" = 0 ]; then ok "selftest"; else bad "selftest failed" "see the ✗ lines above; rerun one share with Forge --selftest --part k/$PARTS"; fi
OUT=$(mktemp -t forge-window-check)
rm -f "$OUT"
"$BIN" --window-check "$OUT" >/dev/null 2>&1 &
PID=$!
for _ in $(seq 1 40); do [ -s "$OUT" ] && break; sleep 0.25; done
if grep -q '^ok' "$OUT" 2>/dev/null; then ok "the app opens a window titled Forge"; else bad "no window titled Forge ($(cat "$OUT" 2>/dev/null))" "the main scene is Window(AppInfo.name, ...) in Sources/App/ForgeApp.swift"; fi
# It must then quit by itself (the check calls the same quit path SIGTERM and the updater use).
for _ in $(seq 1 40); do kill -0 "$PID" 2>/dev/null || break; sleep 0.25; done
if kill -0 "$PID" 2>/dev/null; then
  kill -9 "$PID" 2>/dev/null
  bad "the app didn't quit by itself" "never call NSApp.terminate from a main-queue block; use AppDelegate.quitSoon()"
else ok "the app quits by itself"; fi
# And a running copy quits on SIGTERM (what the installer and logout send).
"$BIN" --window-check /dev/null >/dev/null 2>&1 &
PID=$!
sleep 1
kill -TERM "$PID" 2>/dev/null
for _ in $(seq 1 40); do kill -0 "$PID" 2>/dev/null || break; sleep 0.25; done
if kill -0 "$PID" 2>/dev/null; then kill -9 "$PID" 2>/dev/null; bad "the app ignored SIGTERM" "the SIGTERM handler must quit through AppDelegate.quitSoon()"; else ok "the app quits on SIGTERM"; fi
rm -f "$OUT"
if "$BIN" --engine-check; then ok "the engine starts, answers only with its token, is watched and stops"; else bad "engine check failed" "see the ✗ lines above; the engine log is in the scratch folder it names"; fi
SCRATCH=$(mktemp -d -t forge-sessions)
if FORGE_HOME="$SCRATCH" FORGE_CLAUDE_COMMAND="$PWD/engine/test/fixtures/sessions/fake-claude.mjs" "$BIN" --sessions-check; then ok "a chat runs end to end: steer, queue, stop, turns read back"; else bad "sessions check failed" "see the ✗ lines above; its log is in $SCRATCH/logs"; fi
rm -rf "$SCRATCH"
SCRATCH=$(mktemp -d -t forge-archive)
if FORGE_HOME="$SCRATCH" FORGE_CLAUDE_COMMAND="$PWD/engine/test/fixtures/sessions/fake-claude.mjs" "$BIN" --archive-check; then ok "a session archives and comes back from its row, its header and after a relaunch"; else bad "archive check failed" "see the ✗ lines above; its log is in $SCRATCH/logs"; fi
rm -rf "$SCRATCH"
if "$BIN" --transcript-check 2>/dev/null; then ok "a 12,000-turn chat and a 5,000-line diff stay in budget"; else bad "the long-chat budget failed" "see docs/design/sessions.md section 7"; fi

echo; echo "Guardrails"
if python3 tools/lint/forge-lint.py --prove >/dev/null; then ok "every lint rule blocks its planted violation"; else bad "a lint rule let its canary through" "run tools/lint/forge-lint.py --prove"; fi

echo
[ "$fail" = 0 ] && echo "preflight: all passed" || echo "preflight: FAILED"
exit $fail
