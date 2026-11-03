#!/bin/bash
# Every Forge Desktop commit is authored, committed and signed by the identity in .env
# (GIT_AUTHOR_*, GIT_COMMITTER_*, FORGE_GIT_SIGNING_KEY; see .env.example). Nothing here names it.
#
#   tools/check-identity.sh               would the next commit be right? (pre-commit, make check)
#   tools/check-identity.sh --push        pre-push: reads git's "<local ref> <sha> <remote ref> <sha>" lines
#   tools/check-identity.sh --range A..B  every commit in A..B: author, committer, signature
set -u
cd "$(git rev-parse --show-toplevel)"
fail=0
say() { echo "identity: $1" >&2; fail=1; }

if [ ! -f .env ]; then
  echo "identity: no .env in this clone." >&2
  echo "FIX: cp .env.example .env, fill in the commit identity and signing key, then run 'make hooks'." >&2
  exit 1
fi
# Read the five values without exporting them (exported GIT_* would override every git command).
val() { sed -n "s/^$1=//p" .env | tail -1 | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"; }
AN=$(val GIT_AUTHOR_NAME); AE=$(val GIT_AUTHOR_EMAIL)
CN=$(val GIT_COMMITTER_NAME); CE=$(val GIT_COMMITTER_EMAIL)
KEY=$(val FORGE_GIT_SIGNING_KEY)
for v in AN AE CN CE KEY; do [ -n "${!v}" ] || say "$v is empty in .env"; done
[ "$fail" = 1 ] && { echo "FIX: fill in every value in .env (see .env.example)." >&2; exit 1; }

check_config() {
  local a c sk fmt gs
  a=$(git var GIT_AUTHOR_IDENT 2>/dev/null | sed -E 's/ [0-9]+ [-+][0-9]{4}$//')
  c=$(git var GIT_COMMITTER_IDENT 2>/dev/null | sed -E 's/ [0-9]+ [-+][0-9]{4}$//')
  [ "$a" = "$AN <$AE>" ] || say "the next commit's author would be '$a', not the .env author"
  [ "$c" = "$CN <$CE>" ] || say "the next commit's committer would be '$c', not the .env committer"
  sk=$(git config --get user.signingkey || true)
  fmt=$(git config --get gpg.format || echo openpgp)
  gs=$(git config --get --type=bool commit.gpgsign || echo false)
  [ "$sk" = "$KEY" ] || say "user.signingkey is '$sk', not FORGE_GIT_SIGNING_KEY"
  [ "$fmt" = "openpgp" ] || say "gpg.format is '$fmt', must be openpgp"
  [ "$gs" = "true" ] || say "commit.gpgsign is '$gs', must be true"
}

check_range() {
  local h an ae cn ce g k
  while IFS='|' read -r h an ae cn ce g k; do
    [ -n "$h" ] || continue
    [ "$an <$ae>" = "$AN <$AE>" ] || say "${h:0:9} author is '$an <$ae>'"
    [ "$cn <$ce>" = "$CN <$CE>" ] || say "${h:0:9} committer is '$cn <$ce>'"
    { [ "$g" = "G" ] || [ "$g" = "U" ]; } && [ "${k: -16}" = "${KEY: -16}" ] || say "${h:0:9} is not signed with FORGE_GIT_SIGNING_KEY (status '$g')"
  done < <(git log --format='%H|%an|%ae|%cn|%ce|%G?|%GK' "$1" --)
}

case "${1:-}" in
  "") check_config ;;
  --push)
    check_config
    z=0000000000000000000000000000000000000000
    while read -r _lref lsha _rref rsha; do
      [ "$lsha" = "$z" ] && continue
      if [ "$rsha" = "$z" ]; then
        base=$(git merge-base "$lsha" origin/main 2>/dev/null || true)
        if [ -n "$base" ]; then check_range "$base..$lsha"; else check_range "$lsha"; fi
      else
        check_range "$rsha..$lsha"
      fi
    done
    ;;
  --range) check_range "$2" ;;
  *) echo "usage: $0 [--push | --range A..B]" >&2; exit 2 ;;
esac

if [ "$fail" = 1 ]; then
  echo "FIX: run 'make hooks' (writes .env's identity into this clone's local git config), then" >&2
  echo "     rewrite a bad commit with: git commit --amend --no-edit -S --reset-author" >&2
  echo "     Never pass -c user.*, --author or --no-gpg-sign." >&2
  exit 1
fi
exit 0
