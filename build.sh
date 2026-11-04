#!/bin/bash
# Builds build/app.noindex/Forge.app with swiftc (no Xcode project needed).
#   ./build.sh            optimized build
#   FORGE_FAST_BUILD=1    unoptimized, much faster to compile (pull request checks)
#   FORGE_MODULE_CACHE=   a folder CI keeps Apple's prebuilt framework modules in between runs
#   ./build.sh --package  also notarizes and makes build/Forge.zip (the updater's download) and build/Forge.dmg
#   ./build.sh --install  also installs it as /Applications/Forge.app
# Release signing (see .env.example): Developer ID + hardened runtime when an identity is on this Mac,
# ad hoc otherwise. Nothing about the signer is written in this repo.
set -euo pipefail
cd "$(dirname "$0")"
APP=build/app.noindex/Forge.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
OPT=(-O)
[ "${FORGE_FAST_BUILD:-0}" = 1 ] && OPT=(-Onone -wmo -num-threads "$(sysctl -n hw.ncpu)")
[ -n "${FORGE_MODULE_CACHE:-}" ] && OPT+=(-module-cache-path "$FORGE_MODULE_CACHE")
SOURCES=()
while IFS= read -r f; do SOURCES+=("$f"); done < <(find Sources -name '*.swift' | sort)
swiftc "${OPT[@]}" -parse-as-library -target arm64-apple-macosx14.0 -swift-version 5 \
  -framework SwiftUI -framework AppKit -framework Security \
  "${SOURCES[@]}" -o "$APP/Contents/MacOS/Forge"
VERSION=$(tr -d ' \n' < VERSION)
# Where the in-app updater looks for releases: this clone's GitHub repo unless FORGE_UPDATE_REPO says.
UPDATE_REPO="${FORGE_UPDATE_REPO:-$(git remote get-url origin 2>/dev/null | sed -E 's#^(https://github.com/|git@github.com:)##; s#\.git$##')}"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Forge</string>
  <key>CFBundleDisplayName</key><string>Forge</string>
  <key>CFBundleIdentifier</key><string>ai.forjado.forge</string>
  <key>CFBundleExecutable</key><string>Forge</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>ForgeUpdateRepo</key><string>$UPDATE_REPO</string>
</dict></plist>
PLIST
cp LICENSE NOTICE "$APP/Contents/Resources/"
cp -R Resources/Fonts "$APP/Contents/Resources/Fonts"
tools/bundle-engine.sh "$APP/Contents/Resources/engine"
tools/sign-app.sh "$APP"
echo "built $APP ($VERSION)"
case "${1:-}" in
  --package) tools/package-app.sh "$APP" ;;
  --install) tools/package-app.sh "$APP" && tools/install-app.sh "$APP" ;;
esac
