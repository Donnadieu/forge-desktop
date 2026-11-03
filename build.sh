#!/bin/bash
# Builds build/app.noindex/Forge.app with swiftc (no Xcode project needed).
#   ./build.sh            optimized build
#   FORGE_FAST_BUILD=1    unoptimized, much faster to compile (pull request checks)
#   FORGE_MODULE_CACHE=   a folder CI keeps Apple's prebuilt framework modules in between runs
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
</dict></plist>
PLIST
cp LICENSE NOTICE "$APP/Contents/Resources/"
tools/bundle-engine.sh "$APP/Contents/Resources/engine"
codesign --force --deep -s - "$APP" >/dev/null 2>&1
echo "built $APP ($VERSION)"
