---
name: repo-assessment
description: Read a whole repository and say how ready it is for coding agents — how to build, test and run it, what checks and agent docs it already has, what's missing, the risky areas — and propose the guardrails worth adding (formatter, linter, custom rules, ratchet, hooks, CI). Reads only; changes nothing. Use before the harness-engineering skill, or when asked "is this repo ready for agents?".
---

# Repo assessment (read only)

You are judging whether coding agents can work safely in this repository, and which
guardrails would make their mistakes impossible instead of merely discouraged.
**Change nothing**: no edits, no installs, no commits, no network calls beyond
reading the repo itself.

## 1. Read the repo, really

- The manifests (`package.json`, `pyproject.toml`, `Gemfile`, `go.mod`, `Cargo.toml`,
  `Package.swift`, ...), lockfiles, and any `Makefile` / `justfile` / scripts.
- `README`, `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING`, `docs/`.
- CI config (`.github/workflows/`, `.gitlab-ci.yml`, ...), git hooks (`.githooks/`,
  `.husky/`, `lefthook.yml`, `.pre-commit-config.yaml`).
- Formatter / linter / type-checker config (biome, eslint, prettier, ruff, rubocop,
  swift-format, golangci, tsconfig `strict`, mypy, ...).
- The source tree: its layers and folders, the biggest files, the tests and how
  they are laid out.

## 2. Assess

For each area, say what is there and what is missing, with file paths:

1. **Build, test, run:** the exact commands, and whether they are written down where
   an agent would look.
2. **Agent docs:** an `AGENTS.md` (or `CLAUDE.md`) that maps the repo; architecture notes.
3. **Formatting and linting:** which tools, how strict, whether they run in CI and hooks.
4. **Tests:** how many, what they cover, whether CI runs them on every pull request.
5. **Structure:** layers and whether anything stops one reaching into another; files
   over ~500 lines; duplicated code.
6. **Risks:** secrets or credentials in the tree, hard-coded names/emails/URLs, code
   that deletes data or spends money, migrations, anything an agent could break silently.

## 3. Propose guardrails

Propose only guardrails this repo would actually benefit from, each enforced by a
tool (never "agents should remember to..."). Typical ones:

- A stock **formatter** and **linter** for the stack, on in CI and a pre-commit hook.
- **Custom rules** a generic linter can't know, each with a one-line why and a fix an
  agent can follow: maximum file length, layer boundaries (folder A may not import
  folder B), no secrets, no hard-coded identities, banned APIs, side effects only in
  allowed modules, test helpers kept out of production code.
- A **ratchet**: existing violations recorded in a baseline that may only shrink.
- **Agent docs**: `AGENTS.md` + a docs map + architecture notes.
- **CI on every pull request** running format check, lint, the ratchet and tests.
- A **canary** proof that each rule really blocks a bad change.

Rank them: the ones that prevent the most damage for the least effort first.

## 4. Answer

Write the assessment in plain, short sentences a non-engineer can follow. Then end
with exactly one fenced `json` block, nothing after it:

```json
{
  "summary": ["one plain sentence per line, 3 to 6 lines"],
  "how_to": {"build": "command or null", "test": "command or null", "run": "command or null"},
  "has": ["what is already in place, short"],
  "missing": ["what is missing, short"],
  "risks": ["risky areas, short"],
  "guardrails": [
    {"id": "kebab-case-id", "title": "short name", "why": "one line: what mistake it prevents", "recommended": true}
  ]
}
```
