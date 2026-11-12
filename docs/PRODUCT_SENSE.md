# Product sense

**Who:** a developer with a Linear, Basecamp or GitHub Issues board and a GitHub repo who wants agents to drive cards to merged
pull requests, from a Mac app instead of a terminal.
**North star:** simplicity. One workflow, one lead agent, the standard pipeline. If a screen needs
explaining, it's wrong.

## Setup (six screens, one question each)
1. The tracker: Linear (paste the key once), Basecamp or GitHub Issues (approve a short code in
   the browser, each one's device sign-in). The sign-in goes into the Keychain.
2. Pick the project (on Basecamp, its card table; on GitHub, the project and the repo new issues go to). Forge explains the pipeline and offers to create
   missing statuses or columns:
   Backlog, Triage, Todo, In Progress, AI Review, QA, Human Review, Rework, Merging, Done.
3. Sign in to GitHub and choose who authors and signs: you with a key Forge makes and registers,
   your own GPG key, or unsigned with a warning.
4. Pick the repo; Forge checks you can push.
5. The intelligence provider for the project (Claude Code, Codex, Kimi or OpenRouter) and the account it
   uses. Each provider keeps any number of accounts (browser sign-ins and API keys): add, switch or clear
   one. Each account has its own login, so switching never signs another out and the person's own Claude
   Code and Codex logins stay untouched. Checked with one real call.
6. Ready: the agent reads the repo and suggests guardrails; Forge makes one card for them.

Then the **Orchestrator** (the main screen): what's in flight, four stats (Running, Retrying,
Tokens today, Runtime), Running sessions with each agent's live lines, Your turn, Up next, Later.
Start and Stop. No number appears twice on it.

**Workflow Studio** turns optional stages off (Triage, AI Review, QA, Human Review, Merging), sets how
many agents work at once, and has two switches for Forge to move cards out of Backlog itself: new
unassigned cards to Triage (two at a time) and cards marked ready to Todo. Both start off. Nothing
else: no per-stage agents, models or colours yet.
**Workspaces** group trackers, projects, repos and intelligence providers; the chip in the top bar lists them and
switches (switching stops the running one). Sign-ins belong to the Mac and any workspace can use them.
**Sessions** (beside the Orchestrator in the top bar) are the chats you have with agents in the workspace: New
session picks a repo and the first message; the chat streams, folds tool calls, takes a steer mid-turn, stops, goes
back to before a turn; the right panel shows the changes and the pull request (Create PR, Fix errors, Pull review
comments, Merge). Conductor's open workspaces come over in one step. A running card's row on the Orchestrator has
Open session: its whole conversation, a message steers it, Stop takes the wheel and Hand back to Forge gives it back.
**Settings** shows the workspace on screen, in setup's order: trackers, projects and repos, intelligence provider and
account, then GitHub and signing; each
Change opens that setup step. Saving either restarts the engine; agents pick their cards back up.

## Words on screen
Card, column, agent, repo, board, workflow, key, tracker (never "cards" for where they live), intelligence
provider (what does the work for a project: Claude Code, Codex, Kimi, OpenRouter; never "agent" there), "Orchestrator" as the main screen's name, and
"Harness engineering" as the name of getting a repo ready for agents (its Settings tile and setup step),
workspace (a group of trackers, projects, repos and intelligence providers; never the engine's card folders),
connection (one sign-in to a tracker), session (one piece of work on one repo: its folder, branch, chats, changes and
pull request), chat, steer.
Never: orchestrator as an engine word, MCP, harness on its own,
sidecar, token, config, JSON, CLI, terminal as a place to go (lint rule `ui-jargon`). "Terminal" with a capital is the
name of a session's Terminal panel (Nov 12); no screen ever asks the person to type in one.

## Never
- A browser page or web view. Forge is a native Mac window.
- Change someone's Linear, Basecamp or GitHub without asking first (creating statuses, columns or Status options, registering a key).
- Keep a secret anywhere but the Keychain.
- Hardcode a name, email or key ID.
- Start a card whose commits would go out under the wrong name or unsigned without that being chosen.
