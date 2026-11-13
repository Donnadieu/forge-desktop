#!/bin/bash
# Runs a CI run's jobs again when GitHub cancelled one because no runner came (macOS capacity: "The job was not
# acquired by Runner"). .github/workflows/rerun-no-runner.yml calls it with RUN_ID, REPO and GH_TOKEN.
# Leaves alone: real failures, runs cut off by the time limit, runs replaced by a newer push, runs whose branch has
# moved on, and a run already tried MAX_ATTEMPTS times. DRY_RUN=1 says what it would do and does nothing.
#   RUN_ID=<id> REPO=<owner/repo> tools/ci-rerun-no-runner.sh
set -euo pipefail
: "${RUN_ID:?set RUN_ID}" "${REPO:?set REPO}"
MAX_ATTEMPTS=${MAX_ATTEMPTS:-3}

info=$(gh api "repos/$REPO/actions/runs/$RUN_ID" --jq '"\(.run_attempt) \(.head_sha) \(.head_branch)"')
read -r attempt sha branch <<<"$info"
if [ "$attempt" -ge "$MAX_ATTEMPTS" ]; then
  echo "run $RUN_ID: already tried $attempt times, leaving it"
  exit 0
fi
head=$(gh api "repos/$REPO/git/ref/heads/$branch" --jq .object.sha 2>/dev/null || true)
if [ "$head" != "$sha" ]; then
  echo "run $RUN_ID: $branch has moved on (or is gone), nothing to run again"
  exit 0
fi

starved=""
cancelled=$(gh api "repos/$REPO/actions/runs/$RUN_ID/attempts/$attempt/jobs" --jq '.jobs[] | select(.conclusion == "cancelled") | "\(.id)=\(.name)"')
for job in $cancelled; do
  notes=$(gh api "repos/$REPO/check-runs/${job%%=*}/annotations" --jq '.[].message')
  case "$notes" in *"not acquired by Runner"*) starved="$starved ${job#*=}" ;; esac
done
if [ -z "$starved" ]; then
  echo "run $RUN_ID: no job went without a runner, nothing to run again"
  exit 0
fi
echo "run $RUN_ID: no runner came for$starved; running it again (try $((attempt + 1)) of $MAX_ATTEMPTS)"
if [ "${DRY_RUN:-}" = 1 ]; then
  echo "DRY_RUN: would run: gh run rerun $RUN_ID --failed -R $REPO"
else
  gh run rerun "$RUN_ID" --failed -R "$REPO"
fi
