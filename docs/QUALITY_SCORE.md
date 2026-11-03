# Quality score

| Area | Score | Gaps |
|---|---|---|
| App shell | 4/10 | an empty window; starts, watches and drains the engine (proven by `--engine-check`) |
| Engine | 6/10 | imported with Forge's unit tests; runs inside the app behind a local API; no board reader yet |
| Harness | 8/10 | every rule proven by a canary; Keychain-only secrets have no enforcer yet |

Updated: 2026-11-03
