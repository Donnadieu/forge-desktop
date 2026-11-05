/**
 * GitHub Issues on a GitHub Projects (v2) board: the GraphQL Forge sends and
 * how an answer becomes a card. The board's columns are the options of the
 * project's single-select Status field; the cards are the project's issues
 * (draft items and pull requests on the board are not cards). Labels,
 * assignees and comments are the issue's own.
 *
 * New in Forge Desktop (Forge lists `github` as a tracker name only).
 */
import { extractPrUrl, resolveStage } from "./basecamp-normalize.js";
import type { BoardCard, NormalizedIssue } from "./types.js";

/** The issue fields every read asks for. */
export const ISSUE_FIELDS = `
  id number title body url state createdAt updatedAt
  repository { name nameWithOwner }
  assignees(first: 10) { nodes { id login } }
  labels(first: 30) { nodes { name } }
  blockedBy(first: 10) { nodes { number state repository { name } } }
  closedByPullRequestsReferences(first: 5, includeClosedPrs: true) { nodes { url } }
  projectItems(first: 20) {
    nodes {
      id
      project { id }
      fieldValues(first: 20) {
        nodes {
          ... on ProjectV2ItemFieldSingleSelectValue {
            optionId
            field { ... on ProjectV2SingleSelectField { id } }
          }
        }
      }
    }
  }`;

/** One page of the project's items, issues only carrying fields. */
export const PROJECT_ITEMS = `query ProjectItems($project: ID!, $after: String) {
  node(id: $project) {
    ... on ProjectV2 {
      items(first: 50, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { id content { __typename ... on Issue { ${ISSUE_FIELDS} } } }
      }
    }
  }
}`;

/** Issues by node id (states, claims). */
export const ISSUES_BY_ID = `query Issues($ids: [ID!]!) {
  nodes(ids: $ids) { __typename ... on Issue { ${ISSUE_FIELDS} } }
}`;

export const VIEWER = "query Viewer { viewer { id login } }";

export const SET_STATUS = `mutation SetStatus($project: ID!, $item: ID!, $field: ID!, $option: String!) {
  updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field, value: { singleSelectOptionId: $option } }) {
    projectV2Item { id }
  }
}`;

export const ADD_TO_PROJECT = `mutation AddToProject($project: ID!, $content: ID!) {
  addProjectV2ItemById(input: { projectId: $project, contentId: $content }) { item { id } }
}`;

export const ADD_ASSIGNEE = `mutation Assign($issue: ID!, $users: [ID!]!) {
  addAssigneesToAssignable(input: { assignableId: $issue, assigneeIds: $users }) { clientMutationId }
}`;

export const REMOVE_ASSIGNEE = `mutation Unassign($issue: ID!, $users: [ID!]!) {
  removeAssigneesFromAssignable(input: { assignableId: $issue, assigneeIds: $users }) { clientMutationId }
}`;

export const ADD_COMMENT = `mutation Comment($issue: ID!, $body: String!) {
  addComment(input: { subjectId: $issue, body: $body }) { commentEdge { node { id } } }
}`;

export const COMMENTS = `query Comments($issue: ID!, $after: String) {
  node(id: $issue) {
    ... on Issue {
      comments(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { id body createdAt }
      }
    }
  }
}`;

export interface RawStatusValue {
  optionId?: string;
  field?: { id?: string };
}

export interface RawProjectItem {
  id: string;
  project: { id: string };
  fieldValues: { nodes: Array<RawStatusValue | null> };
}

export interface RawIssue {
  __typename?: string;
  id: string;
  number: number;
  title: string;
  body: string | null;
  url: string;
  state: "OPEN" | "CLOSED";
  createdAt: string;
  updatedAt: string;
  repository: { name: string; nameWithOwner: string };
  assignees: { nodes: Array<{ id: string; login: string }> };
  labels: { nodes: Array<{ name: string }> };
  blockedBy?: { nodes: Array<{ number: number; state: string; repository: { name: string } }> };
  closedByPullRequestsReferences?: { nodes: Array<{ url: string }> };
  projectItems: { nodes: RawProjectItem[] };
}

/** Where the issue sits on this project: its item id and the Status option it has (if any). */
export function placement(
  issue: RawIssue,
  projectId: string,
  statusFieldId: string,
): { itemId: string; optionId: string | null } | null {
  const item = issue.projectItems.nodes.find((n) => n.project.id === projectId);
  if (!item) return null;
  const value = item.fieldValues.nodes.find((v) => v?.field?.id === statusFieldId);
  return { itemId: item.id, optionId: value?.optionId ?? null };
}

/** The pipeline column for a Status option, through the board's column map (stage -> option id). */
export function stageFor(optionId: string | null, columns: Record<string, string>): string | null {
  if (!optionId) return null;
  for (const [name, id] of Object.entries(columns)) {
    if (id === optionId) return resolveStage(name) ?? name;
  }
  return null;
}

/** `repo#12`: how GitHub people name an issue; safe as a folder name once `#` is replaced. */
export function identifierOf(issue: RawIssue): string {
  return `${issue.repository.name}#${issue.number}`;
}

export function branchOf(issue: RawIssue): string {
  return `github/${issue.repository.name}-${issue.number}`;
}

/** The pull request that closes the issue (GitHub's own link), else one pasted into its body. */
export function prOf(issue: RawIssue): string | undefined {
  return issue.closedByPullRequestsReferences?.nodes[0]?.url ?? extractPrUrl(issue.body);
}

/** Blockers still open, as identifiers. */
export function openBlockers(issue: RawIssue): string[] {
  return (issue.blockedBy?.nodes ?? [])
    .filter((b) => b.state !== "CLOSED")
    .map((b) => `${b.repository.name}#${b.number}`);
}

export function normalizeIssue(issue: RawIssue, state: string): NormalizedIssue {
  return {
    id: issue.id,
    identifier: identifierOf(issue),
    title: issue.title,
    description: issue.body ?? "",
    state,
    priority: null,
    assignee: issue.assignees.nodes[0]?.login,
    labels: issue.labels.nodes.map((l) => l.name.toLowerCase()),
    branchName: branchOf(issue),
    url: issue.url,
    blockedBy: openBlockers(issue).map((identifier) => ({ identifier })),
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    existingPrUrl: prOf(issue),
  };
}

export function boardCard(issue: RawIssue, state: string): BoardCard {
  return {
    id: issue.id,
    identifier: identifierOf(issue),
    title: issue.title,
    state,
    url: issue.url,
    assignee: issue.assignees.nodes[0]?.login ?? null,
    branchName: branchOf(issue),
    prUrl: prOf(issue) ?? null,
    priority: null,
    updatedAt: issue.updatedAt,
    labels: issue.labels.nodes.map((l) => l.name.toLowerCase()),
    blockedBy: openBlockers(issue),
  };
}
