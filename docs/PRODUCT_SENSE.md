# Product sense

**Who:** a developer with a Linear board and a GitHub repo who wants agents to drive cards to merged
pull requests, from a Mac app instead of a terminal.
**North star:** simplicity. One workflow, one lead agent, the standard pipeline. If a screen needs
explaining, it's wrong.

## Setup (six screens, one question each)
1. Paste the Linear key once; it goes into the Keychain.
2. Pick the project. Forge explains the pipeline and offers to create missing statuses:
   Backlog, Triage, Todo, In Progress, AI Review, QA, Human Review, Rework, Merging, Done.
3. Sign in to GitHub and choose who authors and signs: you with a key Forge makes and registers,
   your own GPG key, or unsigned with a warning.
4. Pick the repo; Forge checks you can push.
5. Choose who does the work: Claude Code, Codex, Kimi, or an API key, checked with one real call.
6. The board: live columns, what the agent is doing now, usage, Start and Stop.

A **Workflow** button on the board always leads back to setup. No Workflow Studio.

## Words on screen
Card, column, agent, repo, board, workflow, key. Never: orchestrator, workspace, MCP, harness,
sidecar, token, config, JSON, CLI, terminal (lint rule `ui-jargon`).

## Never
- A browser page or web view. Forge is a native Mac window.
- Change someone's Linear or GitHub without asking first (creating statuses, registering a key).
- Keep a secret anywhere but the Keychain.
- Hardcode a name, email or key ID.
- Start a card whose commits would go out under the wrong name or unsigned without that being chosen.
