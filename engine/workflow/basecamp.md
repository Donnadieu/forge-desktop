## This board is in Basecamp

The instructions below were written for Linear. This board is a Basecamp Card Table, so read every
Linear step through this section. Where they differ, this section wins.

- A "ticket" or "issue" is a Basecamp card. The card's id is the number after `BC-` in its
  identifier (`BC-123` is card `123`).
- Talk to Basecamp only with the `basecamp_api` tool (the `forge-basecamp` server). There is no
  `linear_graphql` tool here: skip the `linear` skill and any Linear MCP step. One call is one
  request: `method`, `path` (after the account id, ending in `.json`) and, for POST and PUT, a JSON
  `body`. A list result with a `next` path has more pages: call again with that path.
- This board: project `@@PROJECT@@`, card table `@@CARD_TABLE@@`. Columns (name: column id):
@@COLUMNS@@
- Read a card: `GET /buckets/@@PROJECT@@/card_tables/cards/<card>.json` (its column is `parent`).
- Comments: list `GET /buckets/@@PROJECT@@/recordings/<card>/comments.json`; add one
  `POST /buckets/@@PROJECT@@/recordings/<card>/comments.json` with `{"content": "<html>"}`; edit one
  in place `PUT /buckets/@@PROJECT@@/comments/<comment>.json` with `{"content": "<html>"}`.
- Comments are HTML, and Basecamp keeps only these tags: `div`, `h1`, `br`, `strong`, `em`, `a`,
  `pre`, `ul`, `ol`, `li`, `blockquote` (anything else is dropped). Start the workpad with
  `<h1>Forge Workpad</h1>` and the spike with `<h1>Forge Triage</h1>`; write each line as a `<div>`,
  lists as `<ul><li>`, sub-headings as `<div><strong>…</strong></div>`, code as `<pre>`. Checklist items
  are `<li>` lines starting with `[ ]` or `[x]`. Find the workpad by that heading.
- Move a card: `POST /card_tables/@@CARD_TABLE@@/moves.json` with
  `{"source_id": <card>, "target_id": <column id>, "position": 0}`. A plain card update does not move
  it. Then read the card again and check `parent.title`.
- Labels: Basecamp cards have none. A label is a paragraph of its own that reads exactly
  `Label: <name>`. Triage's `ready-for-execution` goes near the top of the `Forge Triage` comment
  (`<div>Label: ready-for-execution</div>`); QA's `qa-complete` goes near the top of the workpad. "Create
  the label if it does not exist" needs nothing here.
- The pull request: Basecamp has no attachments for links. Put the pull request's full URL in the
  workpad (that is how Forge finds it), even where the instructions say to keep it out.
- QA evidence: skip uploading files to the card; post them on the pull request (`gh pr comment`)
  and link that comment from the workpad.
- Follow-up cards: `POST /buckets/@@PROJECT@@/card_tables/lists/@@BACKLOG@@/cards.json` with
  `{"title": "...", "content": "<html>"}` (Backlog). Basecamp has no blocking links: write
  `Depends on: BC-<card>` as a line of the new card's content.
- Assignment: `PUT /buckets/@@PROJECT@@/card_tables/cards/<card>.json` with
  `{"assignee_ids": [...]}` replaces the whole list. Forge assigns cards itself; leave it alone.

