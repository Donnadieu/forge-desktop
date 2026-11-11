# What others see, and editing the workflow file

> **Nov 11, 2026: the workflow file editor was removed.** Omar decided hand edits could break too much: no screen
> shows or edits the file any more, and Forge alone writes it. See [decisions.md](../decisions.md). The "Edit workflow
> file" section below is history.

Asked for by Omar on Nov 9, 2026: he uses Forge for employer and client work and doesn't want anyone to see that
Forge did it; he also wants to edit the workflow file himself, not only toggle stages. He picked Direction A of the
Claude Design round (project 0af51fab): everything sits in Workflow Studio's side panel, and the file editor is its
own page behind "Edit workflow file".

## Marks Forge left (found on a client's repo and board, Nov 9)
- A `forge` label on every pull request (the lead's instructions asked for it).
- Card comments headed "Forge Workpad" and "Forge Triage", with the Mac's name and Forge's folder path in the
  workpad's stamp.
- The engine's own card comment "Forge stopped this run: …".
- `forge/<id>` branches when a tracker gives none.
- A public GitHub signing key titled "Forge" (`/users/<login>/ssh_signing_keys`).
- Web requests saying `Forge Desktop (…)`.
- Prompt words agents could repeat ("Forge finds it there", `qa-plan-forge`).
Commits were already the person's own, with Claude Code's attribution off since 0.2.10.

## What changed for everyone
- The card notes are "## Workpad" and "## Triage notes"; the stamp is `<card>@<sha>`. Older "Forge Workpad"
  comments still count (`workpad-parser.ts`, `board-reader.ts`), so cards in flight keep working.
- The engine's comment says "This run stopped: …". Web requests send a plain user agent. New signing keys are
  titled "Commit signing". `qa-plan-forge` is `qa-plan`. Prompts don't name Forge where an agent could echo it.
- The pull request label is named in a "What others see" note the engine adds after the lead's instructions
  (`tracker/marks.ts`), `forge` unless the workspace says otherwise.

## Keep Forge invisible (per workspace, `marks:` in the workflow file)
`marks.invisible`, `marks.pr_label` (empty = none; absent = `forge`, or none when invisible) and
`marks.branch_prefix` (empty = the tracker's branch name). With the switch on:
- The note tells the agent the rules; every guard uses one check, `findMarks` (the word Forge, "Generated with",
  AI co-author lines, the robot emoji).
- Claude Code's PreToolUse hook in the card's `.claude/settings.local.json` refuses a `git push` whose new commits
  carry a mark, another author or a marked branch name, and a `gh` write (PR, issue, comment, label, api fields,
  body files) with a mark. A PATH wrapper wouldn't work: Claude Code's shell resets PATH.
- git's own `pre-push` hook does the same for any agent, when the repo has no `core.hooksPath` or pre-push of its own.
- The tracker tools (Linear, Basecamp, GitHub) refuse writes with a mark.
- A card already on a branch keeps it (`worker/branch.ts`), so a new prefix never strands an open pull request.
Not covered: Codex agents' `gh` text (no hook point; the pre-push hook and tracker guard still apply).

## Edit workflow file (removed Nov 11, 2026)
- Removed. What stays: a file saved from the editor keeps its mark (`workflow-versions/edited`), and Forge's saves
  merge into it (`WorkflowFile.merge`), so what was typed stays. Everything below describes the page as it was.
- The page shows the on-screen project's WORKFLOW.md. `check-workflow.js` (engine) checks it with the engine's
  own schema: YAML that can't be read, tabs, unknown keys with "Did you mean", wrong types, `{{ … }}` a card can't
  fill. The app adds one rule: settings Workflow Studio or Settings own (`WorkflowFile.appKeys`) and the app's
  marked part of the instructions are changed there, not by hand. A file with any problem is never written.
- Once saved by hand, the file is the person's: app saves merge only the owned settings and the marked part into
  it (`WorkflowFile.merge`), so hand edits survive. Forge's newer lead instructions then don't reach that file;
  "Forge's own file" under Saved versions starts over from Forge's.
- Every change keeps the file before it (last 20) in `workflow-versions/`: "Undo last save" and "Put back" load one
  into the editor; Save applies it and restarts the engine.
