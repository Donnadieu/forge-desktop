# Plan: Sessions polish (Omar's Nov 11 walkthrough)

Follow-up to [sessions.md](sessions.md). Omar walked through the built Sessions screen on Nov 11 and listed what to
fix. What he likes stays as it is: a ticket opens a session right away, "Started by Forge", the card banner ("Forge is
working this card. Anything you send steers its agent right away."), the status pill and title, the flowing stream of
tool calls, commands and thoughts, and commenting on diff lines.

## Rules for this plan
- Every item is test-first: a check that fails on the old code, then the fix, then green. Each PR names the check.
- Each fix is looked at in an offscreen render (`Forge --render-screens`) next to Omar's screenshot. No visible window.
- One small PR per item or per tight pair. Decisions go in [decisions.md](../../decisions.md).
- Tick a box only when its PR is merged to main and its check passes.

## Merged
- 1: PR #91 (`17cc65e`). 2: PR #92 (`a6463e9`). 3: PR #93 (`90586cc`). 4: PR #95 (`e5fd791`). 5: PR #97 (`b330255`). 6: PR #99 (`7773b31`). 7: PR #101 (`d112576`). 8: PR #102 (`8d7fda4`). 9: PR #104 (`4b751c6`). 10: PR #105 (`4a88bd1`). 11: PR #106. Released in 0.2.29. 12: PR #117, released in 0.2.34.

## Out of scope
Codex and Kimi chats, the model picker listing every provider, the Claude Design visual pass, and the setup changes
(workspace = project, Board rename, locked project). Omar sends those separately.

## Progress
- [x] 1. Layout: the Changes panel never spills over the chat or its composer; each pane has a clear edge at every window width
- [x] 2. Card prompt bubble: Markdown rendered (headings, lists, bold, code), collapsed to a short preview with "Show full prompt"
- [x] 3. Thought rows open on click, like tool rows
- [x] 4. A clear, compact style for commands, their output, file reads and edits
- [x] 5. Syntax highlighting by language in the diff panel and in chat code blocks
- [x] 6. Scroll stays put when scrolled up; a "Jump to latest" pill; auto-follow only at the bottom
- [x] 7. Tabs: new ones named Chat 2, Chat 3; "Review" renamed Changes and shown only once there are changes; right-click Rename and Close; X on hover
- [x] 8. Create PR sends the agent a create-PR prompt (like Conductor's create-PR skill); nothing made silently
- [x] 9. New session = new worktree and branch off main by default; the sheet can pick an existing branch or name a new one; repo locked to the workspace
- [x] 10. Sessions sidebar grouped; idle and finished groups collapse
- [x] 11. Conductor import scoped to the workspace's repo, multi-select, "Import selected", no "Into workspace" column
- [x] 12. Chat Markdown: GFM tables drawn as tables, task lists as boxes; paths into the worktree are links that open Forge's file viewer (Markdown rendered, diffs coloured, code numbered; Cmd-click shows it in Finder). Check: `Checks.chatRenderChecks`
