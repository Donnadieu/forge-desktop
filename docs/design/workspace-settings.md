# Workspace setup, notifications, environment and the session terminal

Asked for by Omar on Nov 12, 2026, after he went through Conductor's settings: "I don't want feature parity with
Conductor. I don't want to be Conductor either." He kept five things and said "do all", so this was built without a
design round. Decisions are logged in [decisions.md](../decisions.md).

Built in Forge's current design system (`Sources/UI/Theme.swift`, `Controls.swift`): tiles on `panel()`, section
labels in caps, mono for paths and keys, heat for the one primary action. Few choices: every part is one list or one
box, with nothing to pick that Forge can decide.

## What's kept from Conductor, and what isn't

| Conductor | Forge |
|---|---|
| Scripts (setup, run, archive) + Miscellaneous (files to copy) | One screen, **Workspace setup**: files to copy, setup script, cleanup script |
| Environment | On the same screen: **Environment**, a key/value list, secrets in the Keychain |
| Agent notifications + completion sound picker | One switch, **Agent notifications**, on by default; one chime, no picker |
| Send with Enter, follow-up behaviour, steer or queue | No settings: Enter sends, Shift-Enter is a new line, a message sent while the agent works steers it |
| Long text as a file or text | No setting: over 4,000 characters becomes a `.txt` attachment with a chip |
| Terminal | A real shell in each session, in its folder, as a bottom panel |
| Account, billing, appearance, shortcuts, default models, git, agents, run script, actions | Not built |

## 1. Settings: two new tiles

The Settings grid gains a third row. Workspace setup's Change opens its own screen; the notifications tile is the
switch itself (no screen behind it).

```
┌ Settings ─────────────────────────────────────────────────────────────────────────────────┐
│ ACME · WORKSPACE                                                                          │
│ Acme                                                       [Rename] [Delete workspace]    │
│                                                                                           │
│ ┌ TRACKERS ──────────────────────┐  ┌ PROJECTS AND REPOS ────────────┐                     │
│ ┌ INTELLIGENCE PROVIDER ─────────┐  ┌ GITHUB ────────────────────────┐                     │
│ ┌ HARNESS ENGINEERING ───────────┐  ┌ WORKSPACE SETUP ───────────────┐                     │
│ │                                │  │ FILES COPIED   .env, config/   │ [Change]            │
│ │                                │  │                master.key      │                     │
│ │                                │  │ SETUP SCRIPT   bin/setup       │                     │
│ │                                │  │ CLEANUP SCRIPT None            │                     │
│ │                                │  │ ENVIRONMENT    3 variables,    │                     │
│ │                                │  │                1 secret        │                     │
│ └────────────────────────────────┘  └────────────────────────────────┘                     │
│ ┌ AGENT NOTIFICATIONS ───────────┐                                                        │
│ │ A chime and a notification when│                                       [ (●) on ]       │
│ │ an agent finishes, needs you or│                                                        │
│ │ stops. On this Mac.            │                                                        │
│ └────────────────────────────────┘                                                        │
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

## 2. Workspace setup screen

One page, four parts, one Save. Applies to every repo of the workspace; paths are relative to each repo's top folder.

```
┌ Forge · Settings ──────────────────────────────── [‹ Back to Settings  esc] ───────────────┐
│ ACME · WORKSPACE SETUP                                                                    │
│ Workspace setup                                                                           │
│ What every new session gets before its agent starts, and what runs when it's archived.   │
│                                                                                           │
│ ┌ FILES TO COPY ─────────────────────────────────────────────────────────────────────────┐ │
│ │ Files git ignores, copied from your checkout into each new session's folder.          │ │
│ │ .env files always come along.                                                          │ │
│ │  config/master.key                                                              (x)    │ │
│ │  storage/dev-seeds/                                                             (x)    │ │
│ │ [ path, e.g. config/master.key        ] [Add]   [Add from repo ▾]                     │ │
│ └────────────────────────────────────────────────────────────────────────────────────────┘ │
│ ┌ SETUP SCRIPT ──────────────────────────────────────────────────────────────────────────┐ │
│ │ Runs in the new session's folder when it starts. Its output shows in the session; if   │ │
│ │ it fails the agent still starts.                                                       │ │
│ │ ┌────────────────────────────────────────────────────────────────────────────────────┐ │ │
│ │ │ bundle install && yarn install && bin/rails db:prepare                             │ │ │
│ │ └────────────────────────────────────────────────────────────────────────────────────┘ │ │
│ └────────────────────────────────────────────────────────────────────────────────────────┘ │
│ ┌ CLEANUP SCRIPT ────────────────────────────────────────────────────────────────────────┐ │
│ │ Runs in the session's folder when it's archived, before the folder goes.               │ │
│ │ ┌──────────────────────────────────────────────────────────────────────────────────┐   │ │
│ │ │ bin/rails db:drop                                                                │   │ │
│ │ └──────────────────────────────────────────────────────────────────────────────────┘   │ │
│ └────────────────────────────────────────────────────────────────────────────────────────┘ │
│ ┌ ENVIRONMENT ───────────────────────────────────────────────────────────────────────────┐ │
│ │ Given to every agent, script and terminal in this workspace. Secrets stay in your      │ │
│ │ Mac's Keychain and are never written to a file.                                        │ │
│ │  KEY                 VALUE                                  SECRET                     │ │
│ │  RAILS_ENV           development                             [ ]          (x)          │ │
│ │  STRIPE_KEY          ••••••••                                [x]          (x)          │ │
│ │ [ + Add variable ]                                                                     │ │
│ └────────────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                    [Cancel]  [Save]        │
│ New sessions and terminals use these at once; card agents get them when the engine        │
│ restarts.                                                                                  │
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

"Add from repo" opens a popover listing what git ignores in the workspace's checkouts (folders end in `/`), each
with a tick; ticking adds it to the list. A repo with no checkout on this Mac has nothing to copy, and the popover
says so.

A secret's value is typed once into a masked field; on Save it goes to the Keychain (`workspace-env.<workspace>.<key>`)
and the row shows `••••••••` from then on. Typing a new value replaces it; removing the row deletes the item.

## 3. In the session: setup output

The setup runs before the first message goes to the agent. A strip at the top of the chat shows it.

```
┌ chat ─────────────────────────────────────────────────────────────────────────────────────┐
│ ◌ Setup script running · 12s                                                  [Show ▾]    │
│ ─ or, when it failed ─                                                                    │
│ ✗ Setup script failed (exit 1). The agent started anyway.                     [Show ▾]    │
│   │ bundle install                                                                │       │
│   │ Could not find gem 'pg'                                                       │       │
│ ─ or, when it passed ─                                                                    │
│ ✓ Setup script finished in 41s                                                [Show ▾]    │
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

Secret values are replaced by `••••••••` in the output before it is kept or shown.

## 4. Terminal: a bottom panel in the session

A Terminal button in the session's top row (⌃\`) opens the panel; the drag bar resizes it; `+` opens another shell;
each tab closes with its x. The shell is the person's login shell, started in the session's folder with the
workspace's environment. Archiving the session closes its shells.

```
┌ chat ─────────────────────────────────────────────────────────────────────────────────────┐
│ …transcript…                                                                              │
│ ┌ message box ──────────────────────────────────────────────────────────────────────────┐ │
├══════════════════════════════════ drag ═══════════════════════════════════════════════════┤
│ [Terminal 1 ×] [Terminal 2 ×] [+]                                             [Hide ⌄]    │
│ ~/…/folders/acme-app/fix-login % bin/rails test                                           │
│ Running 412 tests in parallel using 8 processes                                           │
│ ...........                                                                               │
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

Never another directory: a session whose folder isn't there gets no terminal ("This session's folder isn't on this
Mac."), and an archived one none at all.

## 5. The message box (no settings)

- Enter sends; Shift-Enter adds a line; ⌥Enter queues (kept from before).
- Sent while the agent works, a message steers the running turn and shows in the transcript as a steer.
- A paste over 4,000 characters doesn't go into the box: it becomes a `.txt` file attached to the message, shown as a
  chip above the box (`▤ Pasted text · 5,214 characters  ×`). The agent gets the whole text with the message.

```
┌ message box ─────────────────────────────────────────────────────────────────────────────┐
│ [▤ Pasted text · 5,214 characters ×]                                                     │
│ Here's the log, find why the job failed                                                  │
│ [+] [Skills]                                            [Opus 5.5 · High] Context 4% [Send]│
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

## 6. Agent notifications

One switch (Settings tile, on by default, Mac-wide). When a chat stops working:
finished → "<title> is done", waiting on the person → "<title> needs you", failed → "<title> stopped". One chime
(macOS's Glass), one notification; a click opens that session (its workspace first). Nothing for the session the
person is looking at while Forge is in front.

## Where it lives

| Part | App | Engine |
|---|---|---|
| Settings saved | `Workspace.setup` (`Core/WorkspaceSetup.swift`), secrets in the Keychain | none on disk |
| Copy, setup, cleanup, env | app pushes `POST /api/v1/workspaces/<id>/setup` on connect and on Save | `sessions/workspace-setup.ts`, kept in memory |
| Card agents' env | `EngineSettings.environment` adds the workspace's variables | inherited by agents |
| Terminal | `EngineHost/TerminalProcess.swift` (PTY), `Core/TerminalScreen.swift` (VT parser), `UI/TerminalPanel.swift` | none |
| Notifications | `UI/AgentNotice.swift` | none |
| Long paste | `UI/Composer.swift` | `sessions/attachments.ts` (`[text: …]` lines) |

## Not built (V2 thinking, said once)
Copying files and running scripts for card workspaces (the board engine has its own hooks), a run script, per-repo
setup, a terminal theme, notification sounds.
