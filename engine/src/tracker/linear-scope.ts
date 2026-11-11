/**
 * Which cards a Linear board covers: one project (`project_slug`) or, when no
 * project was picked, the whole team (`team_id`). Every Linear read that lists
 * cards filters through this, so the two never drift apart.
 *
 * New in Forge Desktop.
 */
import type { TrackerConfig } from "./types.js";

export interface LinearScope {
  /** The GraphQL variable declaration, e.g. `$slug: String!`. */
  varDecl: string;
  /** The `issues(filter:)` clause that uses it. */
  clause: string;
  /** The variable's name and value, for the query's variables. */
  variables: Record<string, string>;
}

export function linearScope(config: Pick<TrackerConfig, "project_slug" | "team_id">): LinearScope {
  if (config.project_slug) {
    // PITFALL #3: Use project: { slugId: { eq: $slug } } for project filtering
    return {
      varDecl: "$slug: String!",
      clause: "project: { slugId: { eq: $slug } }",
      variables: { slug: config.project_slug },
    };
  }
  if (config.team_id) {
    return {
      varDecl: "$team: ID!",
      clause: "team: { id: { eq: $team } }",
      variables: { team: config.team_id },
    };
  }
  throw new Error("Linear project slug is required");
}
