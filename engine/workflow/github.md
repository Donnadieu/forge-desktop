## This board is GitHub Issues

The instructions below were written for Linear. This board is a GitHub project with issues, so read
every Linear step through this section. Where they differ, this section wins.

- A "ticket" or "issue" is a GitHub issue on the project. Its identifier is `<repo>#<number>`; the
  `id` you are given is the issue's node id (`I_…`).
- Talk to the board with the `github_graphql` tool (the `forge-github` server): one GraphQL query or
  mutation per call, with `variables`. There is no `linear_graphql` tool here: skip the `linear` skill
  and any Linear MCP step. Code, branches and pull requests still go through `gh` and git as usual.
- This board: project `@@PROJECT@@`, its Status field `@@FIELD@@`. New issues go to `@@REPO@@`.
  Columns are the Status options (name: option id):
@@COLUMNS@@
- Read an issue with its column:
  `query($id: ID!) { node(id: $id) { ... on Issue { number title body state labels(first: 30) { nodes { name } }
  assignees(first: 10) { nodes { login } } projectItems(first: 20) { nodes { id project { id }
  fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name optionId } } } } } } }`.
  The item whose `project.id` is `@@PROJECT@@` is this board's card; keep its `id` (`PVTI_…`).
- Move a card: `updateProjectV2ItemFieldValue(input: { projectId: "@@PROJECT@@", itemId: "<PVTI_…>",
  fieldId: "@@FIELD@@", value: { singleSelectOptionId: "<option id>" } })`. Then read the issue again
  and check the Status name. Moving to Done doesn't close the issue; merging the pull request does.
- Comments are Markdown. List: `node(id) { ... on Issue { comments(first: 100) { nodes { id body } } } }`.
  Add: `addComment(input: { subjectId: "<issue id>", body: "..." })`. Edit in place:
  `updateIssueComment(input: { id: "<comment id>", body: "..." })`. The workpad is the comment that
  starts with `## Workpad` (older cards: `## Forge Workpad`); the spike is the one that starts with `## Triage notes` (older cards: `## Forge Triage`).
- Labels are GitHub labels. Add `ready-for-execution` (Triage) or `qa-complete` (QA) with
  `gh issue edit <number> -R @@REPO@@ --add-label <name>` (or the issue's own repo); create it first if it
  is missing: `gh label create <name> -R <repo> --force`.
- The pull request: put `Closes <owner>/<repo>#<number>` in the pull request's description. That links
  it to the issue (that is how the board finds it) and closes the issue when it merges. Also put the pull request's
  URL in the workpad.
- QA evidence: post it on the pull request (`gh pr comment`) and link that comment from the workpad.
- Follow-up issues: `gh issue create -R @@REPO@@ --title ... --body ...`, then put it on the board in
  Backlog with `addProjectV2ItemById(input: { projectId: "@@PROJECT@@", contentId: "<issue id>" })` and
  the move above. A blocker is GitHub's own link: `addBlockedBy(input: { issueId: "<blocked issue id>",
  blockingIssueId: "<blocking issue id>" })`; if that fails, write `Depends on: <repo>#<number>` in the body.
- Assignment: issues are assigned for you; leave assignees alone.
