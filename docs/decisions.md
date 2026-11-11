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
