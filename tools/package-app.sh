#!/bin/bash
# Notarizes and staples Forge.app (when FORGE_NOTARY_PROFILE names a notarytool keychain profile and the
# app is Developer ID signed), then makes build/Forge.zip (what the updater downloads) and build/Forge.dmg.
set -euo pipefail
APP="$1"
# No release without the real icon: it ships at every size, and Finder and Stage Manager draw the anvil, never a blank tile.
"$APP/Contents/MacOS/Forge" --icon-check || { echo "the app icon check failed: no package" >&2; exit 1; }
SIGNER=$(codesign -dvv "$APP" 2>&1 || true)
if [ -n "${FORGE_NOTARY_PROFILE:-}" ] && [[ "$SIGNER" == *"Authority=Developer ID Application"* ]]; then
  rm -f build/notarize.zip && ditto -c -k --keepParent "$APP" build/notarize.zip
  xcrun notarytool submit build/notarize.zip --keychain-profile "$FORGE_NOTARY_PROFILE" --wait | tee build/notarize.log
  grep -q "status: Accepted" build/notarize.log || { echo "notarization failed (build/notarize.log)" >&2; exit 1; }
  xcrun stapler staple "$APP"
  rm -f build/notarize.zip
  echo "notarized $APP"
else
  echo "not notarized (no FORGE_NOTARY_PROFILE or no Developer ID signature)"
fi
rm -f build/Forge.zip && ditto -c -k --keepParent "$APP" build/Forge.zip && echo "packaged build/Forge.zip"
STAGE=build/app.noindex/dmg
rm -rf "$STAGE" && mkdir -p "$STAGE" && cp -R "$APP" "$STAGE/" && ln -s /Applications "$STAGE/Applications"
rm -f build/Forge.dmg && hdiutil create -quiet -volname "Forge" -srcfolder "$STAGE" -ov -format UDZO build/Forge.dmg
rm -rf "$STAGE"
echo "packaged build/Forge.dmg"
