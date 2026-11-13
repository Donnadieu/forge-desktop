#!/bin/bash
# One release of everything on main since the last one (docs/RELEASING.md): the VERSION pull request, its checks,
# the fast-forward onto main, the signed and notarized package, the check like a download, the tag and the GitHub
# release. Changes land on main all day; a release carries them all at once.
#   tools/release.sh            release main as the next patch version
#   DRY_RUN=1 tools/release.sh  say what it would release, change nothing
# Needs GH_TOKEN (an account that can push to main), and for the package FORGE_SIGN_KEYCHAIN,
# FORGE_SIGN_KEYCHAIN_ITEM and FORGE_NOTARY_PROFILE (see .env.example). Run it from a clean worktree.
# Exit 0 = released, or nothing new to release (the last line says which); anything else = stopped, with the reason.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
say() { echo "release: $*"; }
stop() {
  echo "release: STOPPED: $*"
  exit 1
}
: "${GH_TOKEN:?set GH_TOKEN to an account that can push to main}"
export GH_TOKEN
git() { command git -c credential.helper= -c 'credential.helper=!gh auth git-credential' "$@"; }
REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner)

[ -z "$(git status --porcelain --untracked-files=no)" ] || stop "this folder has changes; run it from a clean worktree"
git fetch -q --tags --force origin main
main_version=$(git show origin/main:VERSION | tr -d ' \n')
last=$(git describe --tags --abbrev=0 --match 'v[0-9]*' origin/main)
if ! git rev-parse -q --verify "refs/tags/v$main_version" >/dev/null; then
  stop "main says $main_version but v$main_version isn't tagged yet: another release is under way"
fi
open_versions=$(gh pr list -R "$REPO" --state open --search 'Version in:title' --json number,title --jq '.[] | select(.title | test("^Version [0-9]")) | "#\(.number)"')
[ -z "$open_versions" ] || stop "a version pull request is already open ($open_versions)"

notes=$(git log --reverse --no-merges --format='- %s' "$last..origin/main" | grep -v -E '^- Version [0-9.]+$' || true)
if [ -z "$notes" ]; then
  say "NOTHING NEW: main has nothing since $last"
  exit 0
fi
IFS=. read -r major minor patch <<<"$main_version"
next="$major.$minor.$((patch + 1))"
git ls-remote --exit-code -q origin "refs/tags/v$next" >/dev/null && stop "v$next already exists on GitHub"
say "Forge $next ($(echo "$notes" | wc -l | tr -d ' ') changes since $last):"
echo "$notes"
if [ "${DRY_RUN:-}" = 1 ]; then
  say "DRY_RUN: nothing changed"
  exit 0
fi
for v in FORGE_SIGN_KEYCHAIN FORGE_SIGN_KEYCHAIN_ITEM FORGE_NOTARY_PROFILE; do
  [ -n "${!v:-}" ] || stop "$v isn't set, so the package can't be signed and notarized"
done

# 1. The VERSION pull request.
branch="version-$next"
git checkout -q -B "$branch" origin/main
echo "$next" >VERSION
git add VERSION
git commit -q -m "Version $next"
[ "$(git log -1 --format=%G?)" = G ] || stop "the version commit isn't signed (make hooks sets the identity)"
git push -q -u origin "$branch"
pr_url=$(gh pr create -R "$REPO" --base main --head "$branch" --title "Version $next" --body "Forge $next carries:
$notes")
pr=${pr_url##*/}
say "opened $pr_url"

# 2. Its checks, then the fast-forward onto main. If main moved meanwhile, rebase and wait again (3 tries).
wait_checks() {
  local sha deadline=$((SECONDS + 2400)) states
  sha=$(git rev-parse HEAD)
  while :; do
    states=$(gh api "repos/$REPO/commits/$sha/check-runs?per_page=50" \
      --jq '[.check_runs[] | select(.name == "app" or .name == "engine" or .name == "identity")] | group_by(.name) | map(max_by(.id)) | map("\(.name)=\(.status)/\(.conclusion)") | join(" ")')
    case " $states " in
      *"=completed/failure"* | *"=completed/timed_out"*) stop "a check failed on $pr_url: $states" ;;
    esac
    [ "$(echo "$states" | grep -o 'completed/success' | wc -l | tr -d ' ')" = 3 ] && return 0
    [ "$SECONDS" -lt "$deadline" ] || stop "the checks didn't finish in 40 minutes on $pr_url: $states"
    sleep 30
  done
}
for try in 1 2 3; do
  wait_checks
  git fetch -q origin main
  if git merge-base --is-ancestor origin/main HEAD; then
    git push -q origin HEAD:main
    break
  fi
  [ "$try" -lt 3 ] || stop "main kept moving; $pr_url is green but not merged"
  say "main moved; rebasing $branch on it"
  git rebase -q origin/main
  git push -q --force-with-lease origin "$branch"
done
sha=$(git rev-parse HEAD)
[ "$(gh api "repos/$REPO/commits/$sha" --jq .commit.verification.verified)" = true ] || stop "main's new commit isn't verified on GitHub"
for _ in 1 2 3 4 5 6; do
  [ "$(gh pr view "$pr" -R "$REPO" --json state --jq .state)" = MERGED ] && break
  sleep 5
done
gh pr view "$pr" -R "$REPO" --json state --jq .state | grep -qx MERGED || stop "main has $next but $pr_url doesn't show merged"
git push -q origin --delete "$branch" || true
say "Version $next is on main ($sha)"

# 3. The package, from that exact commit, checked like a download.
./build.sh --package
check=$(mktemp -d -t forge-release-check)
ditto -x -k build/Forge.zip "$check"
xattr -w com.apple.quarantine "0081;$(printf %x "$(date +%s)");Safari;" "$check/Forge.app"
gatekeeper=$(spctl -a -vv -t exec "$check/Forge.app" 2>&1 || true)
case "$gatekeeper" in *"Notarized Developer ID"*) ;; *) stop "the downloaded app isn't notarized: $gatekeeper" ;; esac
xcrun stapler validate "$check/Forge.app" >/dev/null 2>&1 || stop "the downloaded app has no stapled ticket"
built=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$check/Forge.app/Contents/Info.plist")
[ "$built" = "$next" ] || stop "the package says $built, not $next"
"$check/Forge.app/Contents/MacOS/Forge" --engine-check >/dev/null || stop "the downloaded app's engine check failed"
rm -rf "$check"
say "the package is signed, notarized, stapled, and its engine runs"

# 4. The tag and the release.
git tag -s "v$next" -m "Forge $next"
git push -q origin "v$next"
gh release create "v$next" build/Forge.zip build/Forge.dmg -R "$REPO" --title "Forge $next" --notes "$notes" --latest >/dev/null
say "RELEASED Forge $next: https://github.com/$REPO/releases/tag/v$next"
say "install it with: tools/install-app.sh $PWD/build/app.noindex/Forge.app"
