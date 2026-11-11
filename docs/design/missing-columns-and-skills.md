# Missing columns, parking, Next step and skills in sessions

What Omar agreed on Nov 11, 2026, after setting up a work Linear team ("ATC Rewrite") that has only
Backlog, Triage, Todo, In Progress and Done. He won't add columns to a shared team board: it would change
the Kanban for the whole team. So Forge's extra columns are optional, and Forge works around the missing
ones without anything the team can see. Plan and progress: [exec-plans/active/missing-columns-and-skills.md](../exec-plans/active/missing-columns-and-skills.md).
Decisions made while building: [design-docs/decisions.md](../design-docs/decisions.md) rows 10 and up.

## Words
- **Column**: a status on the person's board (Linear state, Basecamp column, GitHub Status option).
- **Stage**: a step of Forge's pipeline (Triage, AI Review, QA, Human Review, Rework, Merging, ...).
- **Required columns**: Backlog, Todo, In Progress and Done. Setup still needs these; without them
  there is nothing to pick up and nowhere to finish.
- **Optional columns**: Triage, AI Review, QA, Human Review, Rework and Merging.
- A stage is **unavailable** when its column is missing, and **off** when the person turned it off in
  Workflow Studio. Unavailable is decided by the board, off by the person.

## 1. Setup: Continue works with missing columns
- Continue needs a team and the four required columns, nothing else.
- "Add them to Linear…" stays, as an option. It still asks first and runs only when tapped.
- Under the list, one plain line says what happens without them: "Forge will work on Todo and In Progress
  cards. AI Review, QA, Human Review, Rework and Merging have no column here, so Forge won't move cards
  into them. You can still run those steps from the Orchestrator." The list names only the missing ones.
- The same rule for Basecamp card tables and GitHub project Status options.
- Setup saves the board's column names (`SetupChoices.boardColumns`), so Workflow Studio and the
  workflow file know which stages are unavailable without reading the board again. The engine also
  refreshes them from every board read.

## 2. Workflow Studio: unavailable stages
- A stage whose column is missing shows greyed out with its reason ("No AI Review column on ATC Rewrite")
  and its switch can't be turned on.
- When the column appears (setup's "Add them", or someone adds it), the stage becomes available again,
  with the person's own on/off choice as it was.
- The person's choices for stages that have columns are never touched.

## 3. Orchestrator gating
- A stage runs only if its column exists AND it's on: `active_states` leaves out unavailable stages too.
- Forge never moves a card into a column that doesn't exist: the lead's routing note never names a missing
  column as a target, and the engine's own moves (`POST /cards/<id>/move`, backlog promotion) refuse a
  column the board doesn't have, before calling the tracker.

## 4. Parking: "Waiting on you"
When In Progress finishes and the next stage (the first one after it that isn't turned off) has no column:
- The card stays In Progress on the board. No comment, no move, nothing the team sees at that moment.
- The pull request opens as a DRAFT (the routing note says so; the team sees a draft, not a finished PR).
- The agent leaves a small local marker in the card's folder (`.forge/parked`, JSON with the stage it
  stopped before and one plain line). It's in the folder's git exclude, so it never reaches a commit.
- The engine reads the marker when the turn ends and parks the card in `forge.sqlite`
  (`parked_cards`: issue id, identifier, the column it sat in, the next stage, the line, when). Parking
  survives a restart.
- The "don't end the turn while the issue is active" continuation loop stops for a parked card: no
  continuation turn, no retry, and dispatch skips the card while it's parked.
- If a teammate moves the card on the board, the board wins: the park row is dropped the next time the
  engine sees the card in a different column, and the card is worked as usual.
- The Orchestrator shows parked cards in "Your turn" with a "Waiting on you" pill and their line.

## 5. Orchestrator "Next step"
- A "Next step" menu on each card in Your turn and on running/parked rows. It lists stage moves only:
  AI review, QA, Human review, Rework, Merge. No other skills.
- Picking one runs that stage now, even without its column:
  - The stage has a column: the card moves there (the engine checks the column exists) and the pipeline
    carries on as usual.
  - It has none: the engine runs that stage's step locally on the card (a one-off stage run recorded in
    `forge.sqlite`, so a restart doesn't lose it). The card stays In Progress on the board, and parks
    again ("Waiting on you") when the step ends. Human review without a column just parks it for you.
- A stage that is off by choice is still offered: picking it is the person's call.

## 6. Skills in sessions
- Forge finds skills in: the session's repo (`.claude/skills`, `.agents/skills`, `.codex/skills`,
  `.cursor/skills`, `skills`), `~/.claude/skills`, Codex's (`$CODEX_HOME/skills`, default `~/.codex/skills`),
  and Forge's own stage skills (the bundled `engine/skills`).
- A skill is a folder with a `SKILL.md`; its name and description come from the front matter, falling
  back to the folder name and the first plain line.
- Only `<folder>/<name>/SKILL.md` files are read (one level, symlinks not followed out of the folder).
  Nothing else on disk is opened.
- The list is cached per folder and refreshed when a folder changes (its modified time and the listing).
- In a session: a "Skills" button by the message box opens a friendly list (name, where it's from, one
  line, a search box). Clicking a skill runs it: Claude Code sessions get `/<name>` when Claude Code can
  see the skill itself (the repo's `.claude/skills`, `~/.claude/skills`); for the others Forge sends one
  line telling the agent to read that skill's `SKILL.md` and follow it.
- Typing `/` at the start of the message box opens the same list, filtered as you type.

## Not in this round
- Creating columns automatically. Moving cards backward. Showing which skills ran on a card.
