# Workspaces v2: a workspace is a repo

Status: **design, not built. Waiting for Omar to pick Direction A or B.** Pictures in `docs/design/workspaces-v2/`
(offscreen renders in Forge's current look, made from HTML with the tokens in `Sources/UI/Theme.swift` by `workspaces-v2/source/gen.py`; the app's own
screens of today are `Forge --render-screens`). Builds on [workspaces-design.md](workspaces-design.md) and
[sessions.md](sessions.md).

## 1. What Omar said (Nov 11 2026, walking through 0.2.26 after a fresh install; cleaned up, meaning unchanged)

1. Workspaces: "ConstructEase" and "personal" make sense.
2. The Orchestrator decides where to pull cards from, and that works.
3. Workflow Studio can be edited. "What would I use Workflow Studio for?"
4. Settings: the screen says "ConstructEase settings", but what it holds is really Orchestrator-wide settings.
5. Sessions: in Conductor each workspace is a repo. Forge should map the same way: adding a workspace means picking a
   repo (his example: Andela's "apply yourself"), and sessions and cards live under that repo's workspace.
6. Bug: "Delete workspace" wouldn't let him delete his workspaces to start from zero. Fixed on its own in 0.2.27
   (PR #86): any workspace can be deleted, the last one too.

## 2. Today, as built (0.2.26)

**Since then (checked on main after 0.2.38, Nov 12):** the pick is still open and none of sections 4 to 8 is built.
Settings is still one workspace-titled screen with Mac-wide tiles ("Projects and repos" included), a workspace still
starts from a tracker, and the Mac-wide agent limit still sits in Workflow Studio. Shipped meanwhile, and kept by both
directions: any workspace can be deleted (0.2.27), setup asks for the workspace's name (0.2.28), sessions show and act
on only their own workspace's sessions (0.2.31), the Conductor import lists only the workspace's repo (0.2.29), and
Settings gained per-workspace Workspace setup and a Mac-wide Agent notifications switch
([workspace-settings.md](workspace-settings.md), 0.2.37). Workflow Studio no longer edits the workflow file (0.2.33).

| Thing | Where it lives | Belongs to |
|---|---|---|
| Tracker connections (several per kind) | `store.json` trackers | the Mac |
| GitHub accounts, intelligence provider accounts | `store.json`, Keychain | the Mac |
| Agents at once across every workspace (default 6) | `SetupStore.agentCeiling`, shown in Workflow Studio | the Mac |
| Who signs commits | `SetupChoices.carried()` | the Mac |
| Projects (one tracker project, one repo each) | `store.json` projects | a workspace |
| Workflow Studio (stages, roles, agents per project, what others see, Backlog moves) | `Workspace.workflow` | a workspace |
| Session repos, session model and effort | `Workspace.repos`, `sessionModel` | a workspace |

So the data is already split between the Mac and the workspace. The screens hide it: Settings is titled with the
workspace's name but most of its tiles (trackers, provider accounts, GitHub, signing) are Mac-wide, and the Mac-wide
agent limit sits inside Workflow Studio. A workspace starts from a tracker, and a repo only appears behind a tracker
project, which is the opposite of Conductor.

## 3. Answers to his two questions

**What is Workflow Studio for?** It sets how Forge works a board on its own: which stages a card goes through on its
way to a merged pull request (Triage, AI Review, QA, Human Review, Merging can be turned off), who works each stage
(Codex builds, Claude reviews), how many cards run at once, and what a client sees (keep Forge invisible). It does
nothing for sessions you start yourself, and nothing for a workspace with no board. Both directions say this on the
screen itself: a short "Use it to" or "What it's for" panel, the card's path drawn as it's set now, and a plain line
when the workspace has no board.

**What is per workspace and what is global?** Global = "Orchestrator settings" (Omar's word): sign-ins on this Mac
(trackers, GitHub accounts), intelligence provider accounts and the default for new workspaces, agents at once across
all workspaces, how commits are signed, Forge's version, and "Start from zero" (delete every workspace). Per workspace =
"Workspace settings": its repo (or repos), its board (optional), who works there (provider, model, effort), session
defaults (branch it starts from, branch prefix), Harness engineering for its repo, what others see, Rename, Delete.
Workflow Studio stays per workspace and loses the Mac-wide agent limit.

## 4. Direction A: one repo, one workspace (Conductor's way, recommended)

Adding a workspace = picking a repo from the GitHub accounts on this Mac. Its name is the repo's name. The board is
optional and connected later in Workspace settings; with no board, the workspace is sessions only and the Orchestrator
tab is greyed out with one line saying why.

- **a1 Add a workspace:** repo list by GitHub account, with search; repos that already are a workspace are greyed.
  "No board for now" is the default.
- **a2 Switcher:** one row per repo workspace: repo, its board, and whether it runs.
- **a3 Workspace settings:** repo (base branch, local checkout, which GitHub account pushes), Harness engineering, the
  optional board, who works here, session defaults, what others see, Rename, Delete. The lead links to Orchestrator
  settings.
- **a4 Orchestrator settings:** sign-ins, providers, this Mac (agents at once, signing), Forge (version, Start from
  zero). Reached from a gear in every top bar (⌘,).
- **a5 Workflow Studio:** "How Forge works this workspace's board on its own…", a "Use it to" panel with three
  examples, the card's path as set now (QA off shows crossed out), then the stage rows.
- **a6 Sessions:** the list is this repo's sessions only, by status. New session asks only for the branch and the first
  message. Card sessions show "Started by Forge".

Why A: it's what Omar asked for word for word, and it's Conductor's model he already works in. It removes the
"Projects and repos" mapping and the tracker-first setup. A tracker project already maps to one repo today, so one
board per repo workspace loses nothing. Forge was reset on Nov 11, so there's no data to migrate on his Mac; for other
installs, each project becomes its own workspace (section 7).

Cost: ConstructEase with two repos becomes two workspaces in the switcher.

## 5. Direction B: a workspace holds repos (Conductor's sidebar inside a client workspace)

A workspace stays a client or a part of his work (ConstructEase, Personal, Andela), but it starts from repos: New
workspace asks for a name and one or more repos; a board is optional per repo.

- **b1 New workspace:** name, then pick one or more repos, board optional.
- **b2 Settings, workspace tab:** one Settings screen with two tabs, "<name> workspace" and "Orchestrator · all
  workspaces". The workspace tab lists its repos with each one's board and Harness engineering, plus who works there
  and what others see.
- **b3 Settings, Orchestrator tab:** the same global settings as a4.
- **b4 Workflow Studio:** "The rules Forge follows when it takes a card from your board and works it without you", the
  card's trip as numbered steps, a "What it's for" panel, and "Applies to" listing which repos have a board.
- **b5 Sessions:** the list groups sessions under each repo, with a ＋ per repo, like Conductor's sidebar.

Why not B first: it keeps two levels (workspace, then repo) and a mapping screen, which is the part Omar found
confusing, and it isn't what he described.

## 6. What stays the same in both

Sign-ins belong to the Mac. Several workspaces run at once and share the Mac-wide agent limit. The Orchestrator, its
tables and card moves don't change. Workflow Studio keeps its stages, roles and "What others see"; only its words and
the purpose panel are new, and the Mac-wide agent limit moves to Orchestrator settings. Sessions keep Direction A of
sessions.md.

## 7. Data model change (A)

- `Workspace` gains `repo` (owner/name, its local checkout, base branch, the GitHub login that pushes) and an optional
  `board` (tracker connection + project). `Workspace.repos` (sessions' extra repos) and `projects` collapse into these.
- Migration for a store that has projects: each project becomes a workspace named after its repo, keeping its
  folder, Workflow Studio answers and running state; a project with no repo yet becomes a workspace that asks for one.
  Session repos without a project become sessions-only workspaces.
- `SetupStore.agentCeiling` and signing stay where they are; only the screen that shows them changes.

## 8. Build order after the pick

1. Settings split: Orchestrator settings (global) and Workspace settings (per workspace), Workflow Studio's purpose
   panel and path strip, agents-at-once moved. Look and words only, no engine change.
2. Add workspace = pick a repo, board optional; sessions-only workspaces.
3. Store migration (section 7) with selftest checks on a 0.2.26 store.
4. Sessions list scoped to the workspace's repo (A) or grouped by repo (B).

## 9. Open questions (with a recommendation each)

1. A board whose cards belong to two repos? Recommendation: one board project per repo workspace, as today's
   one-project-one-repo rule already enforces.
2. Name of a repo workspace: repo name ("apply-yourself") or owner/name? Recommendation: repo name, renameable, with
   owner/name under it.
