#!/bin/bash
# CI: every commit in A..B is signed and verified by GitHub, and author = committer.
# CI has no copy of the key, so it asks GitHub. Needs GH_TOKEN and GITHUB_REPOSITORY.
#   tools/ci-verified.sh A..B
set -u
fail=0
for sha in $(git rev-list "$1"); do
  read -r verified reason < <(gh api "repos/$GITHUB_REPOSITORY/commits/$sha" --jq '"\(.commit.verification.verified) \(.commit.verification.reason)"')
  ae=$(git log -1 --format=%ae "$sha"); ce=$(git log -1 --format=%ce "$sha")
  if [ "$verified" != "true" ]; then echo "✗ ${sha:0:9} is not verified on GitHub ($reason)"; fail=1; fi
  if [ "$ae" != "$ce" ]; then echo "✗ ${sha:0:9} author and committer differ"; fail=1; fi
  [ "$verified" = "true" ] && [ "$ae" = "$ce" ] && echo "✓ ${sha:0:9} verified"
done
if [ "$fail" = 1 ]; then
  echo "FIX: commit with the identity in .env (make hooks), signed: git commit --amend --no-edit -S --reset-author."
  echo "     Land with a local fast-forward (docs/HARNESS.md), never a GitHub squash or rebase."
  exit 1
fi
