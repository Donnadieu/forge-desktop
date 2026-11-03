# Forge Desktop

Forge for Mac. A native SwiftUI app (the window) that runs the Forge board engine (TypeScript,
copied from Forge) beside it. You point it at a Linear project and a GitHub repo, press Start,
and one lead agent drives the cards to merged pull requests. **Simplicity is the north star.**

Status: building (see the plan's Progress). The engine is imported from Forge and runs inside the app; the window is still empty.

## Stack
Swift 6 toolchain (language mode 5) / SwiftUI + AppKit / macOS 14+, Apple Silicon / no Xcode project:
`swiftc` via `build.sh`. Engine: TypeScript on Node 22 (pnpm), Biome, Vitest.

## Commands
    make hooks      # once per clone: hooks on + .env's commit identity into local git config
    make build      # build build/app.noindex/Forge.app
    make format     # format Sources/ (swift-format, .swift-format)
    make lint       # Forge Desktop's own rules + the debt list may only shrink
    make engine     # engine: Biome + layer-boundary tests
    make check      # identity + format-check + lint + engine + preflight: must pass before a commit lands

## Map
- [docs/INDEX.md](docs/INDEX.md): every doc
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): app layers, engine layers, what may call what
- [docs/PRODUCT_SENSE.md](docs/PRODUCT_SENSE.md): who it's for, the setup, words on screen, never-dos
- [docs/design-docs/golden-principles.md](docs/design-docs/golden-principles.md): each rule and what enforces it
- [docs/HARNESS.md](docs/HARNESS.md): linters, the ratchet, hooks, CI, identity, how changes land
- [docs/exec-plans/](docs/exec-plans/README.md): the plan in progress and the debt list
- [engine/README.md](engine/README.md): where the engine comes from and how pulls are recorded

## Rules that bite
- Every rule in `tools/lint/forge-lint.py` prints a `FIX:`; follow it. List: `tools/lint/forge-lint.py --list`.
- Debt lives in `tools/lint/baseline.json`. It may only shrink. Never add to it.
- Max 400 lines per file. Split by area; no "Misc" files.
- Never name the project Forge was based on. Credit lives only in NOTICE.
- Twelve-factor: no names, emails or key IDs in the repo. Identity comes from `.env` (see `.env.example`).
- Native window only: no browser views. Plain words on screen (card, column, agent, repo).
- Commits are authored, committed and signed by the identity in `.env`. `main` has linear history;
  changes land by local fast-forward after CI is green (docs/HARNESS.md), never a GitHub squash.
- For `gh`, use `GH_TOKEN=$(gh auth token -u <the org admin account>)` rather than the active account.

## Skills (the compound loop)
Repo playbooks live in [.agents/skills/](.agents/skills/). Before work: load the one that matches.
After work: update it with what you learned. A mistake seen twice becomes a rule in
`tools/lint/forge-lint.py` (with a canary, so `--prove` keeps it honest).
