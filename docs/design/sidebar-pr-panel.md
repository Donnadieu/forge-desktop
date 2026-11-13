# Sidebars, the PR panel, the branch and archive: design

Status: **built, Direction A (Omar's pick, Nov 12).** Omar's request (Nov 11, 2026),
from the Andela workspace's ATC-1742 card session: both sidebars collapse and resize, a calmer Changes panel that stays
in sync with GitHub the way Conductor's does, the branch in the header can be copied and renamed, and sessions archive
from the sidebar. His rule: the Steve Jobs approach. Don't overwhelm. Keep what he likes: the session header (ticket name,
"Ready for review", repo, branch, "Started by Forge") and the list of changed files. Pictures in
`docs/design/sidebar-pr-panel/`.

Builds on Sessions (docs/design/sessions.md, Direction A) and Sessions polish (docs/exec-plans/active/sessions-polish.md).
Nothing here changes the board engine.

## 1. What's there today (0.2.33)

| Piece | Today | Code |
|---|---|---|
| Left sidebar | Fixed 260 pt, always on | `SessionsScreen.swift:15` |
| Right sidebar | Fixed 360 pt; "Hide changes" in the top bar hides it (⌘⇧D) | `ChangesPanel.width`, `SessionsScreen.swift:66` |
| PR line | Branch chip + "vs main", then a `PR #1288 · Open` pill, "Checks pass", "Open ↗" | `ChangesPanel.swift:41-108` |
| Actions | Pull review comments (always, with a PR) + Merge (always) + Fix errors (when checks fail) + "…" | `ChangesPanel.swift:110-143` |
| PR data | `gh pr view --json number,title,state,url,isDraft,statusCheckRollup`; no mergeability, no review state, no thread count | `engine/src/sessions/github.ts:33` |
| Refresh | When the panel appears, the session changes, a turn ends, or the refresh button | `ChangesPanel.swift:81-86` |
| File rows | Status box (M/A/D), file name, +/− | `ChangesPanel.swift:145` |
| Branch | Plain text in the header line | `ChatColumn.swift:70` |
| Archive | Right-click > Archive, or ⌘⇧A; archived sessions live in History | `SessionList.swift:155`, `HistorySheet.swift` |

Two things today that the design fixes, not just restyles:
- **Merge shows even when GitHub would refuse it** (conflicts, behind a protected main, review required). The panel
  never asks GitHub whether the PR can merge.
- **Archiving a card session deletes the card's live folder.** `host.archive` runs `git worktree remove --force` on
  the session's folder, and a card session's folder is the running card's own workspace (`sessions/cards.ts` `follow`).
  Read from the code, not reproduced (it would destroy a real card's work).

## 2. Both sidebars collapse and resize

- Both edges get the same control: a 1 pt divider with a 6 pt invisible grab area, the left-right resize cursor, and a
  drag that snaps the sidebar closed when it goes under its minimum. Double-click the divider: back to the default width.
- Both get the same toggle, in the same style, at the same place in the top bar: **left toggle** at the top bar's left
  edge after the workspace picker (`sidebar.left`, "Hide sessions" / "Sessions", ⌘⇧S), **right toggle** where "Hide
  changes" is now (`sidebar.right`, "Hide changes" / "Changes", ⌘⇧D). Same `ForgeButton(kind: .ghost)`, same label
  pattern, same keyboard style.
- Widths: sessions 200–400 pt (default 260), changes 300–560 pt (default 360). Nothing inside a panel may be wider than
  the panel (the long-branch bug from polish stays fixed: rows truncate in the middle).
- **Remembered per window** with `@SceneStorage("sessions.left.width")`, `…left.open`, `…right.width`, `…right.open`.
  Forge has one main window today (`Window(AppInfo.name, id: "main")`), so per window is the same as per app until
  there are more.
- When the window is too narrow for chat ≥ 480 pt plus both panels, the right panel closes first, then the left.

## 3. The Changes panel, in sync with GitHub

### What it shows, top to bottom
1. **The PR line.** `#1288 ↗` as one link (opens the PR on GitHub), then **one status sentence**, then **one button**.
   No branch chip (the header has the branch), no "vs main", no Open ↗ (the number is the link), no pill.
2. **Review comments**, only when there are unresolved threads: "3 review comments · Pull into chat". It is the
   primary button only when comments are the top blocker (below); otherwise it's a quiet text link.
3. **The files.** "36 files changed  +2,075 −918", then one row per file: folder dimmed, file name bright, middle
   truncation, a comment bubble with the count of unresolved threads on that file (Conductor's `💬 2`), then +/−. No
   M/A/D box: a new file's name is green, a deleted file's name is dimmed with a strike, everything else plain.

With **no PR yet**: the PR line is a **Create PR split button** (Conductor's): the main part "Create PR" sends the
agent the existing create-PR prompt (`Sessions.Prompt.createPR`); the arrow opens "Create draft PR" (same prompt plus
"open it as a draft") and "Create PR manually" (pushes the branch if needed, then opens
`https://github.com/<repo>/compare/<base>...<branch>?expand=1` in the browser). Disabled until there's a change.

### The one status, from GitHub's own answer
Ask, in this order; the first match wins. Exactly one primary button at a time.

| # | GitHub says | Shows | Primary button | What it does |
|---|---|---|---|---|
| 1 | `state == MERGED` | Merged | none ("Archive" in the … menu) | |
| 2 | `state == CLOSED` | Closed | none | |
| 3 | `mergeable == UNKNOWN` | Checking with GitHub… (spinner) | none | ask again after 3, 6 and 12 s |
| 4 | `isDraft` | Draft | **Ready for review** | `gh pr ready <n>` |
| 5 | `mergeable == CONFLICTING` (`mergeStateStatus == DIRTY`) | Conflicts with main | **Resolve** | sends the agent the resolve-conflicts prompt |
| 6 | a check run concluded failure / error / timed out / action required, or a status is failure/error | Checks failing (2 of 5) | **View** | opens the failing checks inline, each with its log link, and one "Fix in chat" (today's fix-errors prompt) |
| 7 | `reviewDecision == CHANGES_REQUESTED` | Changes requested by @name | **Pull into chat** | today's pull review comments sheet |
| 8 | unresolved review threads > 0 | 3 review comments | **Pull into chat** | same |
| 9 | `mergeStateStatus == BEHIND` | Branch is behind main | **Update** | GraphQL `updatePullRequestBranch` (REBASE when the base requires linear history, else MERGE), then the session folder fast-forwards if it has no unpushed work; if the agent is mid-turn, the update waits for the turn to end |
| 10 | checks pending | Checks running (3 of 5) | none | the 60 s refresh picks up the end |
| 11 | `reviewDecision == REVIEW_REQUIRED` | Waiting for review | none | |
| 12 | `mergeStateStatus == BLOCKED` and none of the above | Blocked by a repo rule | **View on GitHub** | opens the PR |
| 13 | `mergeStateStatus` CLEAN, HAS_HOOKS or UNSTABLE (UNSTABLE = only optional checks fail, row 6 already caught required ones) | **Ready to merge** (green) | **Merge** | today's confirm, then `gh pr merge` the way the repo allows |

Why this order: you can't fix anything else while there are conflicts; failing checks and requested changes are work
for the agent; "behind" is mechanical and cheap, so it comes after the agent's work (updating first would only re-run
checks that are going to fail again).

Real states seen on GitHub, Nov 11 (open PRs on rails/rails, vercel/next.js, facebook/react, microsoft/vscode and
Donnadieu/forge-desktop#88), which become the test fixtures:
- `MERGEABLE + CLEAN` and success: 21 on rails. `CONFLICTING + DIRTY`: 9. `MERGEABLE + BLOCKED + FAILURE`: 3.
- `UNKNOWN + UNKNOWN`: 24 of 60 on rails on the first ask; forge-desktop#88 answered UNKNOWN first, then
  `MERGEABLE + BEHIND` a few seconds later. GitHub computes mergeability lazily, so row 3 has to retry.
- Drafts never came back as `mergeStateStatus == DRAFT` (deprecated); they're `BLOCKED` with `isDraft: true`, which is
  why row 4 reads `isDraft`, not the state.
- `BLOCKED + APPROVED + SUCCESS` with unresolved threads (conversation resolution required) and without (another rule,
  e.g. code owners or a merge queue): rows 8 and 12.
- `BLOCKED + CHANGES_REQUESTED + PENDING`: row 7 wins over row 10.

### The data: one GraphQL call per refresh
Replaces `gh pr view` in `engine/src/sessions/github.ts` (same account resolution, `gh api graphql`):

```graphql
repository(owner, name) { pullRequests(headRefName: $branch, first: 1, orderBy: {field: CREATED_AT, direction: DESC}) { nodes {
  number url title state isDraft mergeable mergeStateStatus reviewDecision baseRefName headRefName
  latestReviews(first: 20) { nodes { state author { login } } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { nodes {
    ... on CheckRun { name status conclusion detailsUrl isRequired(pullRequestNumber: $n) }
    ... on StatusContext { context state targetUrl isRequired(pullRequestNumber: $n) } } } } } } }
  reviewThreads(first: 100) { nodes { isResolved isOutdated path } }
} } }
```

The engine returns `{number, url, state, isDraft, mergeable, mergeStateStatus, reviewDecision, checks[], unresolved,
threadsByPath}` plus `status: {tone, label, action}` from `mergeStatus` (engine `sessions/github.ts`, a pure function
tested against the recorded answers in `engine/test/fixtures/github/pr-states/`). It lives in the engine rather than
Swift so the tests read GitHub's own JSON. The Swift panel only draws the status and maps `action` to its one button.
In practice it's two calls: find the branch's PR number (`pullRequests(headRefName:)`), then this query by number,
because `isRequired` needs the number. When the repo marks some checks required, only those block; otherwise every
failing check does.

### Staying in sync
- On window focus (`NSApplication.didBecomeActiveNotification`) and when the session on screen changes.
- After any push: the host already sees each turn end; it also refreshes when a Bash tool call in the turn ran
  `git push` or `gh pr`.
- Every 60 s while the panel is on screen and the app is active; stops when hidden or in the background.
- Right after every button (Merge, Update, Ready for review), then again at +5 s, because GitHub's answer lags.
- Row 3 (UNKNOWN) retries at 3, 6 and 12 s on its own.
- One call per session at a time; a refresh that's already running isn't started twice.
- The refresh button goes away: the panel is never stale long enough to need it.

## 4. The branch in the header

- The header line stays "andela-technology/andela · serve-directory-…-atc-1742 · Started by Forge". The branch part
  becomes a button: a click copies it ("Copied" for a second, in place).
- A small chevron after it opens a menu: **Copy branch name**, **Rename branch…**.
- Rename: a one-field sheet with the current name, Rename / Cancel. It runs, in the session's folder:
  `git branch -m old new`, `git push -u origin new`, then deletes the old remote branch, and saves the new name on the
  session (the header and the list follow).

**What renaming does to an open PR (tested Nov 11 on Donnadieu/forge-desktop-test#7, throwaway):** GitHub's own branch
rename (`POST /repos/{o}/{r}/branches/{b}/rename`) **closed the PR** within seconds, and `gh pr reopen` then failed
("Could not open the pull request") because its head branch no longer exists. GitHub has no way to point an existing PR
at a new branch. So a rename always ends that PR. The two directions treat this differently (section 7).

A card session's branch belongs to the board's agent: Rename is hidden there (Copy stays).

## 5. Archive from the sidebar

- Hover a row: the row takes the hover fill and an archive icon (`archivebox`) appears at its right edge, where the
  unread dot sits (the dot hides while hovered). Click = archive. The right-click menu keeps Archive too.
- Archived sessions move to an **Archived** group at the bottom of the list, folded by default, with its count like the
  other groups ("ARCHIVED 12"). Opening it lists them dimmed; hover shows **Unarchive** (`arrow.uturn.backward`) in
  the same spot, and the right-click menu says Unarchive; an archived row never offers Archive. Unarchive = `unarchive`
  (folder back on its branch from the repo it came from, files as they were; the session goes back to its group).
- Clicking an archived row opens it read-only: its chat, an Archived pill, **Unarchive** in its header, no message box
  and no Changes panel. If its folder and branch are both gone, Unarchive says so plainly and the chat stays readable.
- An imported session's folder is the other app's (a Conductor workspace): archiving it only hides it, like a card's.
- History stays as the full list with search (bottom of the sidebar), so the Archived group shows the 20 newest and
  "Show all in History" after that.
- **A running card session asks once:** "Archive AIT-3? Forge is still working this card. Archiving hides it here; the
  card keeps running on the board." Archive / Cancel. Card sessions never get their folder removed: archive only
  hides them (`archived: true`, no snapshot, no `worktree remove`). That fixes the bug in section 1. A person's own
  session that's mid-turn asks too ("The agent is still working. Archiving stops it."), since archive stops its chats.

## 6. What doesn't change

The header (title, status pill, repo · branch · "Started by Forge"), the chat tabs, the composer, the diff sheet and
commenting, the pull review comments sheet, the session groups (Needs you, Working, Ready for review, Idle, Merged).

## 7. Two directions

Both use the Forge Design System and today's Sessions screen; they differ in how loud the status is and in rename.
Frames in Claude Design: https://claude.ai/design/p/d4bf2224-e6af-45ae-a3ab-a28bacc5bfcb (`Sessions Redesign.dc.html`,
frames s0 = today, a1–a10, b1–b11). PNGs in `docs/design/sidebar-pr-panel/` (`00-today-forge.png` is the real 0.2.33
render). Claude Design flagged one thing: B's coloured left edge breaks the design system's "no coloured left border on
cards" rule; it was built because the brief asked for it.

**Direction A, "One line" (Conductor's shape).** The PR line is one row: `#1288 ↗` · status sentence (coloured dot) ·
one compact button on the right. Files start right under it. Toggles are labelled ghost buttons in the top bar. Rename
is offered only while there's no PR; with a PR open the menu shows "Rename branch" greyed with "GitHub closes the PR
when its branch is renamed" under it.

**Direction B, "Status card".** The PR line is a small card at the top of the panel with a 3 pt coloured left edge:
the status as a title ("Ready to merge"), one detail line ("5 checks passed · approved by @erika"), the one button
full width, `#1288 ↗` in the card's corner. Toggles are icon-only at each panel's own top corner. Rename works with a
PR open: the sheet says "GitHub closes PR #1288 when its branch is renamed. Forge opens a new PR from the new name with
the same title and description, linking #1288. Review comments stay on #1288." Rename / Cancel.

**Recommendation: A.** It's the quietest (one row, nothing to read twice), it's the shape Omar already likes in
Conductor, and it avoids a rename that silently swaps a PR's number under a reviewer.

## 8. Build order (Direction A), test first. All done Nov 12.

Proven live on Donnadieu/forge-desktop-test (PR #8, closed after): Draft, Ready for review, Ready to merge, Update
(main merged in, the folder caught up), Conflicts with main, rename refused with the PR open, push for a hand-made PR,
rename of a pushed branch with no PR (old name gone on GitHub). "Branch is behind main" needs a branch rule that
private repos on GitHub Free can't have, so it's covered by the recorded forge-desktop#88 answer only.


1. [x] `mergeStatus` mapping (engine) with fixtures from the real states in section 3 (red test per row first).
2. [x] Engine: the GraphQL query + `threadsByPath` (vitest with recorded `gh` output), PROVENANCE row.
3. [x] Sync triggers (focus, 60 s, a tool call that pushed, after actions, UNKNOWN retry at 3, 6, 12 s).
4. [x] Changes panel view + Create PR split button; renders for each status row.
5. [x] Both sidebars: resize, collapse, `@SceneStorage`; selftest that the chat never goes under 480 pt.
6. [x] Branch copy and rename (the engine runs the git commands; a test on a scratch repo with a bare remote).
7. [x] Archive on hover, Archived group, restore, the running-card confirm, and the card-folder fix (red test first:
   archiving a card session must leave its folder in place).
8. [x] `make check`, renders, one signed and notarized release.
