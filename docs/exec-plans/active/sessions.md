# Plan: Sessions (Direction A)

Conductor-style chats inside a workspace. Design, decisions and screens: [design/sessions.md](../../design/sessions.md)
(Omar picked Direction A on Nov 9, plus Direction B's "Open session" button on the Orchestrator's running row).

## Rules for this plan
- One step = one or more PRs, each with `make check` green, renders of every new screen compared with the matching
  Claude Design frame (`docs/design/sessions/a*.png`), and a selftest or engine test that fails without the change.
- Native SwiftUI only, no web views. Files under 400 lines. Engine changes get a PROVENANCE row.
- Tick a box only when its PR is merged to main.
- No release until every box above "Ship" is ticked, and then only after Omar says yes.

## Progress

### 1. Spike (go or no-go before building on it)
- [x] 1.1 A synthetic 12,000-turn chat in a SwiftUI `List`: opens in under 0.5 s, stays under 300 MB, a selftest fails over budget
- [x] 1.2 A 5,000-line diff in fixed-height rows within the same budget
- [x] 1.3 The engine's sessions mode (`--sessions`, home `sessions/`) starts, answers `POST /api/v1/sessions` and streams one Claude Code turn
- [x] 1.4 Steer and Stop on a running turn through the sessions host (engine test with a stand-in `claude`)
- [x] 1.5 The `List` go or no-go (or the `NSTableView` fallback) written into design/sessions.md section 7

### 2. Sessions host and the Sessions screen
- [x] 2.1 Workspace repos and session defaults in `store.json`, with migration and a round-trip selftest
- [x] 2.2 `sessions.sqlite`: sessions, chats, turns, events, outbox (engine tests)
- [x] 2.3 Session folders: a worktree from the local checkout or Forge's clone, fetched first, `<login>/<slug>` branch with no double prefix, `.env*` copied
- [x] 2.4 Sessions screen: Orchestrator | Sessions switch in the top bar, list grouped Needs you / Working / Ready for review / Merged, unread dot (matches a1)
- [x] 2.5 New session: repo, branch from, first message, model chip, Send (matches a1)
- [x] 2.6 Transcript: one row per turn, streaming text, folded tool rows and thinking, Jump to latest (matches a2)
- [x] 2.7 Message box: Enter steers, Option-Enter queues, Stop, pasted text and images, context meter
- [x] 2.8 Model and effort picker per chat (matches a2)
- [x] 2.9 Permission prompts, agent questions as buttons, plan mode with Approve
- [x] 2.10 Several chats per session as tabs; two chats side by side (matches a4)
- [x] 2.11 Survives a restart: outbox replayed, chats resumed, an interrupted turn marked
- [x] 2.12 Notifications (dot, macOS notification, sound), next chat needing you, the keyboard shortcuts in design section 6

### 3. Diff, pull request and review comments
- [x] 3.1 Diff panel: file list with counts, unified diff, hunks loaded per file (matches a2)
- [x] 3.2 Comment on a line or range; the comment joins the message box
- [x] 3.3 Create PR, the PR line with checks, Fix errors, Merge (asks first)
- [x] 3.4 Pull PR review comments sheet (matches a5)
- [x] 3.5 Review: the bundled review skill in a new chat tab of the session
- [x] 3.6 Archive (snapshot to a private ref), History, restore, archive on merge

### 4. Checkpoints
- [x] 4.1 A snapshot before and after each turn; files changed per turn shown on the turn
- [x] 4.2 Revert to before a turn: files restored, later turns removed, the agent's session resumed at that point

### 5. Card sessions
- [x] 5.1 The card engine keeps every card run's full event stream and serves its turns (built: the sessions host follows the run's Claude Code transcript)
- [x] 5.2 "Open session" on the Orchestrator's expanded running row opens the card's session (matches a3)
- [x] 5.3 Steer a running card; Stop and take the wheel; Hand back to Forge (engine test, PROVENANCE row)

### 6. Import from Conductor
- [x] 6.1 Read Conductor's database read-only (a copy), the import sheet with a workspace per repo (matches a6)
- [x] 6.2 Imported chats resume where they left off (transcripts copied into the account's folder)

### 7. Other providers
- [ ] 7.1 Codex chats: steer, interrupt, resume, model list
- [ ] 7.2 Kimi chats: queue only, Stop; the picker greys out what Kimi can't do

### Ship
- [x] 8.1 ARCHITECTURE.md, PRODUCT_SENSE.md (words on screen) and the playbook's Lessons updated
- [ ] 8.2 Every new screen rendered and compared with its Claude Design frame; contact sheet in the PR
- [ ] 8.3 Release (only after Omar's yes)
