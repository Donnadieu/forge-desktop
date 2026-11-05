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
5. Choose who does the work (Claude Code, Codex or Kimi) and how it signs in (the browser or an
   API key), checked with one real call.
6. Ready: the agent reads the repo and suggests guardrails; Forge makes one card for them.

Then the **Orchestrator** (the main screen): what's in flight, four stats (Running, Retrying,
Tokens today, Runtime), Running sessions with each agent's live lines, Your turn, Up next, Later.
Start and Stop. No number appears twice on it.

**Workflow Studio** turns optional stages off (Triage, AI Review, QA, Human Review, Merging), sets how
many agents work at once, and has two switches for Forge to move cards out of Backlog itself: new
unassigned cards to Triage (two at a time) and cards marked ready to Todo. Both start off. Nothing
else: no per-stage agents, models or colours yet.
**Settings** shows what Forge connects to (Linear, project, GitHub, repo, signing, agent); each
Change opens that setup step. Saving either restarts the engine; agents pick their cards back up.

## Words on screen
Card, column, agent, repo, board, workflow, key, "Orchestrator" as the main screen's name, and
"Harness engineering" as the name of getting a repo ready for agents (its Settings tile and setup step).
Never: orchestrator as an engine word, workspace, MCP, harness on its own,
sidecar, token, config, JSON, CLI, terminal (lint rule `ui-jargon`).

## Never
- A browser page or web view. Forge is a native Mac window.
- Change someone's Linear or GitHub without asking first (creating statuses, registering a key).
- Keep a secret anywhere but the Keychain.
- Hardcode a name, email or key ID.
- Start a card whose commits would go out under the wrong name or unsigned without that being chosen.
