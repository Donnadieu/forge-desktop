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
