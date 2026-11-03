#!/bin/bash
# Signs Forge.app. With a Developer ID identity on this Mac: hardened runtime + timestamp, the bundled
# Node first (it needs V8's JIT entitlements), then the app. Without one: ad hoc, for local builds and CI.
#   FORGE_SIGN_ID             identity (default: the first "Developer ID Application" one on this Mac)
#   FORGE_SIGN_KEYCHAIN       a keychain to unlock first
#   FORGE_SIGN_KEYCHAIN_ITEM  login-Keychain item (service) holding that keychain's password
set -euo pipefail
APP="$1"
if [ -n "${FORGE_SIGN_KEYCHAIN:-}" ] && [ -f "$FORGE_SIGN_KEYCHAIN" ] && [ -n "${FORGE_SIGN_KEYCHAIN_ITEM:-}" ]; then
  KCP=$(security find-generic-password -s "$FORGE_SIGN_KEYCHAIN_ITEM" -w 2>/dev/null) && security unlock-keychain -p "$KCP" "$FORGE_SIGN_KEYCHAIN"
  unset KCP
fi
ID="${FORGE_SIGN_ID:-$(security find-identity -v -p codesigning 2>/dev/null | sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' | head -1)}"
if [ -z "$ID" ] || [ "${FORGE_ADHOC:-0}" = 1 ]; then
  codesign --force --deep -s - "$APP" >/dev/null 2>&1
  echo "signed ad hoc (no Developer ID identity)"
  exit 0
fi
ENT=$(mktemp -d)/node.entitlements
cat > "$ENT" <<'ENTS'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
</dict></plist>
ENTS
codesign --force --options runtime --timestamp --entitlements "$ENT" -s "$ID" "$APP/Contents/Resources/engine/node"
codesign --force --options runtime --timestamp -s "$ID" "$APP"
codesign --verify --deep --strict "$APP"
echo "signed with Developer ID"
