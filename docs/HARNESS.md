# The harness

Guardrails enforced by tools, not goodwill. Each rule has a one-line why and a `FIX:` an agent can follow.

## Layers
| Layer | What | Where it runs |
|---|---|---|
| Formatter | `xcrun swift-format` with `.swift-format` (line length 150) | pre-commit, `make check`, CI |
| Custom rules | `tools/lint/forge-lint.py` (`--list` for all) | pre-commit, `make check`, CI |
| Debt ratchet | `tools/lint/baseline.json` may only shrink; `check-baseline.sh` compares with `main` | pre-commit, `make check`, CI |
| Engine | Biome (`engine/biome.json`), `tsc --noEmit`, the engine's unit tests and `engine/test/architecture/boundaries.test.ts`; the macOS process table is also tested on CI's Mac | pre-commit (engine files), `make engine`, CI |
| App gate | `tools/preflight.sh`: build, version, LICENSE/NOTICE inside the app, no secrets or .env values in the bundle, `--selftest`, a real window titled Forge, `--engine-check` (the bundled engine starts, refuses requests without its token, pushes state live, is restarted after a crash, drains on stop), every lint rule proven to block (`forge-lint.py --prove`) | `make check`, CI |
| Identity | `tools/check-identity.sh` (local, against `.env`), `tools/ci-verified.sh` (CI asks GitHub every commit is verified) | pre-commit, pre-push, `make check`, CI |

## The debt list only shrinks
`baseline.json` started empty. A count may go down (`forge-lint.py --update` after paying debt) and
never up; a new entry counts as growth. CI compares with `main`, so editing the file to hide a problem fails.

## Proving the guards
`forge-lint.py --prove` plants one violation per rule in a scratch copy of the repo and checks each is
caught. A rule without a canary fails `--prove`. It runs in every preflight.

## Identity (twelve-factor)
Commits are authored, committed and signed by the identity in the git-ignored `.env`
(`GIT_AUTHOR_*`, `GIT_COMMITTER_*`, `FORGE_GIT_SIGNING_KEY`; see `.env.example`). `make hooks`
writes it into the clone's **local** git config, never global. Nothing in the repo names it; the
lint rule `hardcoded-identity` fails on emails, key IDs and any value from your `.env`.

## Landing a change
1. Branch, commit (signed by the hook-checked identity), `make check` green.
2. Push the branch, open a pull request. CI runs `app`, `engine` and `identity` (3 minutes or less).
3. When all three are green: `git checkout main && git merge --ff-only <branch> && git push origin main`.
   The fast-forward keeps the signatures. Never a GitHub squash or rebase merge (they re-sign as GitHub).
4. Delete the branch.

## Branch protection on `main`
Required checks (`app`, `engine`, `identity`, up to date with `main`), linear history, no force
pushes, no deletions, admins included.
