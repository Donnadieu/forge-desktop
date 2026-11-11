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
