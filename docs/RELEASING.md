# Releasing Forge

Forge ships outside the Mac App Store: Developer ID signed, notarized by Apple, stapled.

## One release for many changes
Changes land on main all day without a release each. `tools/release.sh` releases everything on main since the last
tag in one go, as the next patch version: the steps below, from opening the VERSION pull request to the GitHub
release. `DRY_RUN=1 tools/release.sh` says what it would ship. It stops (and changes nothing more) when a version pull
request is already open, when main's VERSION isn't tagged yet (another release is under way) or when a check fails.

## Build a release

1. Bump `VERSION` in its own pull request; merge it.
2. On `main`, with the signing settings in the environment (see `.env.example`):

   ```bash
   ./build.sh --package     # signs (Developer ID + hardened runtime), notarizes, staples
   ```

   It makes `build/Forge.zip` (what the in-app updater downloads) and `build/Forge.dmg` (first install).
   `tools/sign-app.sh` signs the bundled Node first, with V8's JIT entitlements, then the app.
   `tools/package-app.sh` fails the build unless Apple answers `status: Accepted`.
3. Check it like a download: extract `build/Forge.zip` somewhere new with
   `ditto -x -k build/Forge.zip <dir>` (never plain `unzip` — it mangles the app bundle's
   symlinks/resource forks and makes `spctl`/`codesign` falsely report "a sealed resource is
   missing or invalid" on a perfectly good zip; the in-app updater already extracts with `ditto`,
   so this is a verification-tool bug, not a packaging one), add a `com.apple.quarantine`
   attribute, then `spctl -a -vv -t exec Forge.app` must say `source=Notarized Developer ID` and
   `xcrun stapler validate Forge.app` must pass. `Forge.app/Contents/MacOS/Forge --engine-check`
   must pass on that copy (proves the signed Node still runs).
4. Tag and publish: `git tag -s vX.Y.Z -m "Forge X.Y.Z"`, push the tag, then
   `gh release create vX.Y.Z build/Forge.zip build/Forge.dmg --title "Forge X.Y.Z" --notes-file <notes>`.
   Every release attaches `Forge.zip`, or no installed copy can update.

## Install on this Mac

`./build.sh --install` builds, packages and installs `/Applications/Forge.app`. A running Forge is
asked to quit first (SIGTERM, which Forge treats as Quit: its agents drain before it stops).

## The updater

- `Sources/EngineHost/Updater.swift` reads the repo's releases through the person's `gh` sign-in
  (the repo can be private) at launch and every 6 hours, and offers "Update to X" on the board.
- Installing downloads `Forge.zip`, checks `codesign --verify --deep --strict` and Gatekeeper,
  quits Forge (agents drain), and a small script swaps the app and reopens it.
- Check it from the command line: `Forge --check-update`, and `Forge --update-now`
  (with `FORGE_UPDATE_NO_REOPEN=1` to stage without reopening).
