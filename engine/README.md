# engine/

The board engine Forge Desktop runs beside the app (as a separate process the app starts and stops).
It is **copied from Forge**, the web app's repo (`Forge-Factory-AI/forge`), not written here and not
shared as a package. The two repos only share this code.

**Empty for now.** The first import is step 2 of the plan (docs/exec-plans/active/scaffold.md).

## Where it comes from

- Only the folders listed in [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md#the-engine) come over:
  the board loop, the Linear tracker, the agent runners, card folders, the worker and a local API.
  None of Forge's web platform (database, billing, hosting, accounts, factory chat).
- The layer map is enforced by `test/architecture/boundaries.test.ts`; formatting and lint by Biome
  (`biome.json`, Forge's settings). Run both with `make engine`.

## How a pull from Forge is recorded

1. Pick one Forge commit (full SHA) and copy the files from it. Never mix commits in one pull.
2. Strip anything that names the project Forge was based on (the lint rule `banned-name` fails otherwise).
   Credit stays in the repo's NOTICE file, which travels with copied code.
3. Add or update one row per file in [PROVENANCE.md](PROVENANCE.md): our path, the Forge commit,
   Forge's path, and what we changed. `tools/lint/forge-lint.py` (rule `engine-provenance`) fails
   on any file under `engine/src/` without a row.
4. `make engine` and `make check` green, then one commit titled `engine: pull Forge <short sha>`.

A later pull compares Forge at the recorded commit with Forge today, for the recorded paths only,
and brings over just those changes.
