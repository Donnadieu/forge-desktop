# Golden principles

**Simplicity is the north star.** Fewer screens, fewer choices, fewer files, fewer moving parts.
When two designs work, ship the simpler one.

Each rule names what enforces it. A rule with no enforcer is a gap; close it with a lint rule or a check.

| Rule | Enforced by |
|---|---|
| Native Mac window, never a browser page | `forge-lint: no-browser-view` |
| The window is titled Forge | preflight "the app opens a window titled Forge" (`--window-check`) |
| Plain words on screen | `forge-lint: ui-jargon` |
| Files stay under 400 lines | `forge-lint: file-length` |
| App layers point one way (App -> UI -> EngineHost -> Core) | `forge-lint: core-imports` |
| Programs start from one place | `forge-lint: process-area` |
| Engine layers point one way; no web platform | `engine/test/architecture/boundaries.test.ts` |
| Engine formatting and lint | Biome (`engine/biome.json`) |
| Every engine file records its Forge commit | `forge-lint: engine-provenance` |
| The project Forge was based on is never named (NOTICE only) | `forge-lint: banned-name` |
| No names, emails or key IDs in the repo | `forge-lint: hardcoded-identity` |
| No secrets in the repo or the app | `forge-lint: no-secrets`, preflight bundle checks |
| LICENSE and NOTICE travel with the app | preflight "ships inside the app" |
| Every commit signed by the `.env` identity | `tools/check-identity.sh` (hooks), `tools/ci-verified.sh` (CI) |
| Old debt only shrinks | `tools/lint/check-baseline.sh` |
| Every lint rule really blocks | `forge-lint.py --prove` in preflight |
| Agents can find their way | `forge-lint: docs-map` (links resolve, docs indexed, AGENTS.md ≤ 80 lines) |
| Consistent Swift formatting | `swift-format lint` |
| Secrets only in the Keychain | `forge-lint: keychain-only` (Keychain calls in `Core/Keychain.swift` only, nothing secret in UserDefaults) |
| The lead waits for its helpers | `engine/test/unit/worker/lead-waits-for-helpers.test.ts` (fails on the old runner) |
