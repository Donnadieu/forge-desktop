---
name: linear
description: Use Linear GraphQL API for issue operations like comments, state transitions, and attachments.
---

# Linear GraphQL

Use this skill for Linear GraphQL operations during agent sessions.

## Primary Tool

Use the `forge-linear` MCP server provided in the workspace's MCP config.
It provides authenticated access to the Linear GraphQL API.

Tool input:

```json
{
  "query": "query or mutation document",
  "variables": {
    "optional": "graphql variables object"
  }
}
```

Behavior:

- Send one GraphQL operation per tool call.
- Treat a top-level `errors` array as a failed operation even if the tool call
  itself completed.
- Keep queries/mutations narrowly scoped; ask only for the fields you need.

## Discovering Unfamiliar Operations

When you need an unfamiliar mutation, input type, or field, use introspection:

```graphql
# List all mutations
query ListMutations {
  __type(name: "Mutation") { fields { name } }
}

# Inspect a specific input type
query CommentCreateInputShape {
  __type(name: "CommentCreateInput") {
    inputFields {
      name
      type { kind name ofType { kind name } }
    }
  }
}
```

## Common Workflows

### Query an Issue

Use progressively narrower lookups:

```graphql
# By ticket key (e.g., MT-686)
query IssueByKey($key: String!) {
  issue(id: $key) {
    id identifier title
    state { id name type }
    project { id name }
    branchName url description updatedAt
  }
}

# By identifier filter
query IssueByIdentifier($identifier: String!) {
  issues(filter: { identifier: { eq: $identifier } }, first: 1) {
    nodes {
      id identifier title
      state { id name type }
      project { id name }
      branchName url description updatedAt
    }
  }
}
```

### Query Team Workflow States

Use before changing issue state to get exact `stateId`:

```graphql
query IssueTeamStates($id: String!) {
  issue(id: $id) {
    id
    team {
      id key name
      states { nodes { id name type } }
    }
  }
}
```

### Move Issue to a State

```graphql
mutation MoveIssueToState($id: String!, $stateId: String!) {
  issueUpdate(id: $id, input: { stateId: $stateId }) {
    success
    issue { id identifier state { id name } }
  }
}
```

### Create a Comment

```graphql
mutation CreateComment($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) {
    success
    comment { id url }
  }
}
```

### Edit an Existing Comment

```graphql
mutation UpdateComment($id: String!, $body: String!) {
  commentUpdate(id: $id, input: { body: $body }) {
    success
    comment { id body }
  }
}
```

### Attach a GitHub PR to an Issue

```graphql
mutation AttachGitHubPR($issueId: String!, $url: String!, $title: String) {
  attachmentLinkGitHubPR(
    issueId: $issueId, url: $url, title: $title, linkKind: links
  ) {
    success
    attachment { id title url }
  }
}
```

### Upload a File to a Comment

Three steps:

1. Call `fileUpload` to get `uploadUrl` and `assetUrl`.
2. Upload bytes to `uploadUrl` with `curl -X PUT` and returned headers.
3. Use `assetUrl` in a `commentCreate` or `commentUpdate` body.

```graphql
mutation FileUpload($filename: String!, $contentType: String!, $size: Int!) {
  fileUpload(filename: $filename, contentType: $contentType, size: $size) {
    success
    uploadFile { uploadUrl assetUrl headers { key value } }
  }
}
```

## Lifecycle (owned by WORKFLOW.md)

The card's lifecycle is owned entirely by the workflow instructions, not by this
skill. Use the GraphQL operations here to talk to Linear, but take every column
move from the workflow:

- Claim a `Todo` card by moving it to `In Progress` (fetch the team's states,
  then `issueUpdate` with the exact `stateId`):

```graphql
query IssueTeamStates($id: String!) {
  issue(id: $id) { id team { states { nodes { id name type } } } }
}

mutation MoveIssueToState($id: String!, $stateId: String!) {
  issueUpdate(id: $id, input: { stateId: $stateId }) { success issue { id state { name } } }
}
```

- Keep a single `## Workpad` comment up to date as the only record of
  progress (`commentCreate` once, then `commentUpdate` with its id). The
  app shows this comment in the card's detail.
- Do NOT post separate summary or "ready for review" comments.
- Never move a card backward; the only human-driven loop is `Human Review` ⇄
  `Rework`.

## Usage Rules

- Prefer the narrowest issue lookup: key -> identifier search -> internal id.
- For state transitions, fetch team states first and use exact `stateId`.
- Prefer `attachmentLinkGitHubPR` over generic URL attachment for GitHub PRs.
