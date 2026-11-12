# Decisions

Calls made while building, without stopping to ask, so Omar can read them later and overturn any of them. Newest at
the bottom. Each line: the date, the plan item, the call and why.

## Sessions polish ([exec-plans/active/sessions-polish.md](exec-plans/active/sessions-polish.md))
- 2026-11-11, item 1: the Changes panel's overlap came from its branch chip, which never shrank (`Chip` was
  `fixedSize`), so a long branch made the panel wider than its 360 points and SwiftUI centred the overflow over the
  chat. Chips can now shrink (`fits: true`, middle of the name cut, full name on hover); the panel keeps to its width,
  clips, and has a solid background, so its edge is plain. In the narrowest window (1100) the message box switches to
  short words ("Steering", "24%") instead of pushing past its column.
- 2026-11-11, item 2: every message bubble and the agent's words now draw block Markdown (headings, bullet and numbered
  lists, rules dropped, quotes as plain lines) with inline code in mono on a light wash; code fences keep their
  language for item 5. A message folds when it's over 600 characters or 12 lines, not only a card's prompt, since a
  long pasted message has the same problem. The button says "Show full prompt" in a card's session and "Show full
  message" in the person's own chats. Folded, only the first 1,200 characters are laid out, so huge prompts stay cheap.
- 2026-11-11, item 3: "Thought" rows couldn't open because Claude Code 2.1.32x keeps no words for a thought, only a
  signature (checked in PER-32's transcript: 17 thoughts, all empty). Its hidden `--thinking-display summarized` flag
  brings back a short summary in the stream and the transcript (checked live, Sonnet and Opus). Card agents and chats
  now pass it, but only after asking the command once whether it knows the flag (an unknown option after it shows
  which one Claude Code trips on; no request is made), because an older Claude Code refuses to start with it. The
  `showThinkingSummaries` setting was tried first and did nothing through `--settings`. A thought's first line now shows
  on its row; thoughts recorded before this have no words and say so on hover.
- 2026-11-11, item 4: tool rows get a mark per kind (terminal, file, pencil, search, helper, web, to-do, wrench for the
  rest). Opened, a command shows as `$ command` on its own strip, its output below in a capped (240 pt) scrolling
  panel, an edit as its removed and added lines in red and green (Write shows the new file's first 4,000 characters as
  added lines), and a failed call is tinted with "failed" on its row. The one-line summaries the engine writes stay as
  they are.
- 2026-11-11, item 5: syntax colours come from a small scanner in `Sources/UI/Syntax.swift` (keywords, types, strings,
  numbers, comments for about 15 language families), not a bundled highlighter library: no new dependency, and a diff
  shows lines out of context anyway, so line-by-line colouring is what a parser could give there too. The language
  comes from a code fence's name or the file's name. Colours stay in the design system's warm range: keywords in heat,
  types gold, strings soft green, numbers clay, comments muted. Edits inside tool rows are coloured the same way.
- 2026-11-11, item 6: two things pulled a reader down: every new turn scrolled to the end whatever the position, and
  `defaultScrollAnchor(.bottom)` held the bottom as content grew. Now the anchor is for the first position only (macOS
  15 and later; 14 keeps the old anchor), and new text or a new turn is followed only while the end is on screen. The
  person's own message always brings the chat down, since they just sent it. Following scrolls twice more after the
  first try, because the list measures new rows late and a single scroll stopped short. The existing "Jump to latest"
  pill shows whenever the end is off screen. The check drives the real list in a window far off screen.
- 2026-11-11, item 7: + (and ⌘T) name new tabs Chat 2, Chat 3, skipping numbers already taken; the old code named the
  second tab "Review". "Review renamed Changes, shown only once there are changes" is built as a Changes tab after the
  chat tabs that appears when the session has changed files: it shows the file list and one file's diff (colours and
  line comments as in the sheet), with no agent run. "Review in a new chat" stays in the Changes panel's ⋯ menu for
  when Omar wants an agent review; it's greyed out until there are changes. Each chat tab shows an X on hover (not on
  the last tab or a working one, which can't close) and right-click gives Rename…, Close and Open beside this one.
  Rename saves the title through the chat's settings, which the engine already accepted.
- 2026-11-11, item 8: Create PR already sent a message rather than calling GitHub, but a thin one. It now sends the shape
  of Conductor's create-PR prompt (read from Omar's Conductor workspaces' `PR instructions.md`): "Create a PR", the
  branch and its target, use the repo's own PR skill or template first, commit what's left, push, review the whole
  branch diff, `gh pr create --base <base>` with a short title and description of every change, reply with the link,
  and ask for help when a step fails. Conductor's own tool names are swapped for plain git. The message shows in the
  chat (folded, with "Show full message"), so Omar sees what the agent was asked. No new Forge words reach the PR.
- 2026-11-11, item 9: sessions already got their own worktree, but on a branch named from the first message, so two
  sessions with the same first words collided ("already open in another folder"). A new branch now takes the next
  free name (`-2`, `-3`) against local branches and GitHub's as last fetched (`freeBranch`). The new-session row is
  now: the workspace's repo with a lock (a menu only if the workspace already holds several repos from before; "Add
  a repo…" is gone, and a workspace with no repo can add its one), then New branch | Existing branch. New branch: an
  optional name (Forge names it when empty) "off" the base, main by default. Existing branch: a menu of GitHub's
  branches (fetched, newest first, main on top); the folder opens on the local branch if there is one, else a new
  local branch tracking GitHub's. The base for the diff stays main.
- 2026-11-11, item 10: the list was already grouped (Needs you, Working, Ready for review, Idle, Merged). Each header
  now shows its count and folds or opens on a click; Idle and Merged start folded. The folds hold while Forge is open
  (not saved across launches: a fresh start should show the tidy default). The session on screen still shows inside
  a folded group, and a search opens every group so a match is never hidden.
- 2026-11-11, item 11: the import now asks the engine for the workspace's repo only (`?repo=`), one row per Conductor
  workspace (its title, branch and chat count), every row not brought over yet ticked, a tick-all box, and "Import
  selected (N)" into the workspace on screen; the "Into workspace" column is gone. Rows already brought over show
  greyed with "already here". The test against Omar's real Conductor database showed a second bug: his remotes use
  SSH host aliases (`git@github.com-andela:…`), which the old reader didn't take, so every repo showed by its short
  folder name and could never match a workspace's repo. The reader takes them now. A workspace that still holds
  several repos from before scopes the import to its first one.
- 2026-11-11, session isolation: the sessions list was already filtered by workspace, but the open session was one
  Mac-wide `SessionsModel.selected`, so switching workspaces kept the other workspace's chat, tabs, steer box and
  Changes panel on screen. A workspace now shows, opens and acts on only its own sessions (`SessionsModel+Workspace.swift`)
  and remembers what it had open; one it never opened shows New session. Sessions of other workspaces keep running.
  Notifications still come from every workspace (an agent waiting on you elsewhere is worth knowing): a click opens
  that session's own workspace first, as does the Orchestrator's Open session. ⌘⌥L stays inside the workspace.

## The workflow file is Forge's (Omar, 2026-11-11)
- 2026-11-11: Omar's call: editing WORKFLOW.md by hand could break too much, so the app no longer shows the raw file
  at all. Workflow Studio's "Edit workflow file" page went (its editor, checks, saved versions, Undo and Put back), and
  so did the read-only view first planned in its place: no screen shows, copies or edits the file. Forge alone writes
  it, from the controls in Workflow Studio and Settings; a setting people need comes to the UI later as its own
  control with its own test. A file someone saved from the old editor keeps its mark, so Forge's saves still only
  rewrite the settings the app owns and keep the rest (`WorkflowFile.merge`); the old `workflow-versions/` folder is
  left on disk as it is. The engine's `check-workflow.js` and `config/workflow-check.ts` only served the editor and
  were removed. Lint `raw-workflow-ui` keeps `Sources/UI` away from the file; `Checks.noRawWorkflowChecks` reads every
  screen after setup back with Vision and fails on any sign of the file.

## Chat Markdown and file links (Omar, 2026-11-11)
- 2026-11-11, item 12: Omar's ATC-1742 review summary showed its table as raw pipes and its two report paths as plain
  text. GFM tables now draw as a table (header on a wash, hairlines from the design system, columns aligned as the
  separator row asks, sideways scroll when wide); task lists draw a box. Strikethrough and nested lists already
  rendered. A path is a link only when it names a file that exists inside the session's worktree (symlinks followed,
  so nothing outside it ever opens); a click opens Forge's file viewer (Markdown rendered, a saved diff coloured per
  file, anything else as numbered code), Cmd-click shows it in Finder. Tool rows that read or wrote a worktree file get
  an Open link, and paths in a tool's command and output are links too.
- 2026-11-12: Omar's ATC-1744 Code Review chat: clicking the agent's own Markdown link to a report (link
  words `tmp/git-diffs/….txt`, target the absolute path with `Application%20Support`) showed macOS's "The
  application can't be opened. -50". A link with no scheme isn't a file URL, so `FileLinks.open` returned nil and the
  chat handed it to the system. Every link that names a path (no scheme, `file://`, `name.ext:12`) now goes to Forge:
  a file inside the worktree opens in the viewer, anything else (missing, a folder, outside the worktree) opens the
  viewer's quiet "File not found" note and reads nothing. Only links with a scheme of their own (https, mailto) leave
  for another app, through `FileLinks.openInBrowser`. Outside a session (a card's workpad) a path link opens nothing.
  Check: `Checks.chatLinkChecks`.

## Sidebars, the PR panel, the branch and archive (Omar, 2026-11-12)

- Omar picked Direction A, "One line", of [design/sidebar-pr-panel.md](design/sidebar-pr-panel.md): the Changes panel
  shows the PR number as a link, one status from GitHub and one button, Conductor's shape. No branch chip there; the
  header has the branch.
- Renaming a branch is offered only before a pull request is open: GitHub closes a PR whose branch is renamed and
  can't reopen it (tested on a throwaway PR).
- Archiving a card's session only hides it; the card keeps running on the board and keeps its folder.
- Nov 12, Omar's four bugs in 0.2.35: (1) the Changes panel's edge didn't resize (its panel kept a fixed inner width,
  and a SwiftUI drag on the divider never got the mouse next to AppKit views): dividers are an AppKit strip now, the
  widths live on the model and are saved per window. (2) The panel's buttons clipped: its header rows shorten the
  title, then the button's words, then show an icon, at every width from 300 to 560. (3) The header lines didn't
  meet: every pane header (sessions list, chat, panel, New session) is one shared height. (4) Hover used the open
  session's fill, so two rows looked selected: only the open session is filled; hover is a fainter wash.

## Workspace setup, notifications, environment, terminal ([design/workspace-settings.md](design/workspace-settings.md))
Omar, Nov 12 2026, after going through Conductor's settings: "I don't want to be Conductor." He kept five things
and said do all, so there was no design round; these are the calls made while building.
- Conductor's Scripts and Miscellaneous are one Forge screen, Workspace setup (Settings > Workspace setup >
  Change): files to copy, setup script, cleanup script, environment, one Save. No run script, no per-repo setup:
  the list and scripts apply to every repo of the workspace, paths relative to its top folder.
- Files to copy: only from the person's own checkout (Forge's clone has no ignored files), only paths inside it,
  never over a file the branch already has (that one belongs to the repo). `.env*` files still come along by
  themselves, as before. "Add from repo" lists `git ls-files --others --ignored --directory`; folders end in `/`.
- The setup script runs before the first message reaches the agent, in the session's folder, with the agents'
  environment plus `FORGE_ROOT_PATH` and `FORGE_SESSION_PATH`, in the person's login shell (their PATH). Its output
  shows live in a strip at the top of the chat. A failure shows red with its last lines and the agent starts anyway
  ("without blocking the chat"). A finished run shows until the first turn ends. 15-minute limit.
- The cleanup script runs on archive after the snapshot and before the folder is removed (same environment and
  limit as setup); its result is kept on the session.
- Environment: secret values go only to the Keychain (`workspace-env.<workspace>.<key>`), never `store.json`; the
  host gets them in memory on every connect and on Save, and the sessions store masks them in everything it writes,
  so an agent or script that prints one never puts it in a file. Keys `FORGE_*` are refused. Card agents get the
  variables too (the project's engine environment, Forge's own variables win), from the next engine restart, which
  Save sets up the same way other settings do. Claude Code's own transcripts in `~/.claude/projects` are outside
  Forge's reach: an agent that prints a secret puts it there, as it would in any terminal.
- Agent notifications: one switch on the Settings screen, on by default, for the whole Mac (it was always on before,
  with macOS's default sound). The chime is macOS's Glass, played once by Forge; the notification itself is silent,
  so it never sounds twice. Same three moments as before (done, needs you, stopped), nothing for the session on
  screen while Forge is in front. No sound picker.
- Terminal: a real login shell on a PTY (`forkpty`) and Forge's own small VT screen (xterm subset: colours,
  cursor moves, erase, scroll regions, alternate screen, cursor reports) drawn in DM Mono. No package manager, so no
  SwiftTerm: the app has no dependencies and builds with `swiftc`. A bottom panel under the chat, toggled with the
  session's Terminal button or ⌃`, resized by its top edge, several tabs per session. Hiding keeps the shells running;
  archiving ends them (SIGHUP to the process group, SIGKILL a second later). No text selection or copy yet.
- Message box defaults, no settings: Enter sends, Shift-Enter is a new line, ⌥Enter queues (all as before); a message
  sent while the agent works steers it and shows as a steer (as before). New: a paste over 4,000 characters becomes
  a .txt attachment with a chip; the host keeps the file beside the chat and Claude Code gets its whole text as a
  text block with the message (no tool call). Card sessions paste as before (their messages go to the card's engine).

## The person's own MCP servers in every agent (Omar, 2026-11-12)
Omar: in the Andela workspace Claude "was not able to reach my MCP server for Linear", and the session terminal didn't
list his servers. Causes found live: his Linear server is a project entry in `~/.claude.json` under his own checkout's
path, and Claude Code matches project entries by path (a git worktree maps to its main checkout, a separate clone
doesn't), so Forge's card clones and the worktrees of Forge's clone never got it; the sessions host had no account
variables, so Andela's chats and terminal ran on the Mac's own Claude Code sign-in (another organization); and a login
shell that isn't interactive has no `mise activate`, so `npx` servers failed to start.
- Agents (cards and chats) get the person's servers with `--mcp-config`: user scope, the folder's `.mcp.json`, and
  every project entry whose checkout has the same GitHub repo, without the ones turned off there. Never
  `--strict-mcp-config`, so whatever Claude Code finds itself (claude.ai connectors) stays. A person's server wins a
  name Forge's tracker tool also uses. Forge's Linear tool still comes only with a Linear board.
- The session terminal can't take flags, so Forge's own checkouts (card folders, worktrees of Forge's clone) get the
  same servers as the folder's `.mcp.json`, approved in its `.claude/settings.local.json`, both in the checkout's
  `info/exclude`. Never in the person's own checkout or its worktrees (those find them by themselves), never over a
  repo's own `.mcp.json`. Forge never writes `~/.claude.json`.
- Chats and session terminals run on the workspace's account (the account its project on screen uses), with the same
  variables its card agents get; the sign-in is masked like a secret variable.
- PATH adds mise's and asdf's shims after everything else, only when installed.
- Not solved: claude.ai connectors need a full Claude sign-in (`user:mcp_servers`); a `claude setup-token` sign-in,
  which Forge's accounts keep, can't load them.

## Paste in the message box (Omar, 2026-11-12)

- ⌘V, Edit > Paste, right-click Paste and dictation apps (Wispr Flow) paste into the message box like any Mac text
  field. The box is an AppKit text view (`MessageBox`); its paste keeps the rule from before: a text over 4,000
  characters becomes a .txt chip, a picture alone on the clipboard joins the message, anything else is pasted as
  text. No SwiftUI button holds ⌘V any more, so the other fields and the Terminal paste too.

