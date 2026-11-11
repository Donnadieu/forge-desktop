import { z } from "zod";
import { AgentKindWithCustomSchema } from "./providers.js";

/**
 * Default success-terminal states when a tracker config omits `done_states`.
 * Single source of truth for the config-assembly paths: the Zod schema default,
 * the `index.ts` wiring fallback, and the `workflow-config.ts` builder fallback
 * all reference this so a rename (e.g. adding "Resolved") is a one-line change.
 * A missed copy would silently relabel a successful ticket `cancelled` — the
 * exact bug `done_states` exists to prevent. (The orchestrator reconciler keeps
 * its own defensive default: the orchestrator layer may not import config per
 * ARCHITECTURE.md, and that default only fires if config assembly is bypassed.)
 */
export const DEFAULT_DONE_STATES: string[] = ["Done", "Closed"];

export const WorkflowConfigSchema = z.object({
  tracker: z.object({
    kind: z.enum(["linear", "github", "jira", "basecamp"]),
    project_slug: z.string(),
    // Linear only (Forge Desktop): the team whose cards Forge works on when no
    // project was picked (`project_slug` is then ""). See tracker/linear-scope.ts.
    team_id: z.string().optional(),
    endpoint: z.string().optional(),
    api_key: z.string().optional(),
    active_states: z.array(z.string()).default(["Todo", "In Progress", "Rework"]),
    terminal_states: z
      .array(z.string())
      .default(["Done", "Closed", "Cancelled", "Canceled", "Duplicate"]),
    // The success subset of terminal_states. A ticket reaching one of these
    // while its worker is mid-flight is recorded `completed`, not `cancelled`.
    done_states: z.array(z.string()).default(DEFAULT_DONE_STATES),
    // Label-name scoping (any-of match, case-insensitive). Empty => no filter.
    // The always-on Smith bakes its `smith_*` labels here so the dispatcher
    // filters in the WORKFLOW.md itself rather than being patched at runtime.
    labels: z.array(z.string()).default([]),
    // Basecamp-only fields (BasecampAdapterOptions in src/tracker/basecamp.ts).
    // Ignored by every other tracker kind. `project_slug` above doubles as the
    // Basecamp project (bucket) id — Basecamp has no separate "slug" concept.
    account_id: z.string().optional(),
    identity_id: z.string().optional(),
    // The Card Table's own id (distinct from any column id or the project/
    // bucket id) — required to call Basecamp's dedicated card-move endpoint
    // (POST /card_tables/:id/moves.json). A plain PUT with column_id on the
    // card resource only works moving INTO a Kanban::Triage-type column
    // (whatever the project calls "Backlog"); moving OUT of one 404s, since
    // Basecamp's real move semantics for its built-in Triage/NotNow column
    // archetypes go through this endpoint, not a bare card update.
    card_table_id: z.string().optional(),
    // WORKFLOW.md stage name -> Basecamp Card Table column id, or (GitHub) the
    // Status option id on the project.
    columns: z.record(z.string(), z.string()).default({}),
    // GitHub only (Forge Desktop): the project's single-select Status field.
    // `project_slug` is the project's node id (PVT_…).
    status_field_id: z.string().optional(),
    // Forge moves cards out of Backlog itself (orchestrator/backlog-promotion.ts).
    // Both rules are off by default; the app turns them on from Workflow Studio.
    promote: z
      .object({
        // Unassigned Backlog cards without the ready label -> Triage.
        backlog_to_triage: z.boolean().default(false),
        // Backlog cards carrying ready_label -> Todo.
        ready_to_todo: z.boolean().default(false),
        ready_label: z.string().min(1).default("ready-for-execution"),
        // Stop feeding Triage once it holds this many cards.
        max_in_triage: z.number().int().min(0).default(2),
        // Minimum gap between sweeps.
        interval_ms: z.number().int().min(0).default(300_000),
      })
      .default({}),
  }),
  workspace: z
    .object({
      root: z.string().default("~/forge-workspaces"),
      base_branch: z.string().default("main"),
      hooks: z
        .object({
          after_create: z.string().optional(),
          before_run: z.string().optional(),
          after_run: z.string().optional(),
          before_remove: z.string().optional(),
          timeout_ms: z.number().default(600_000),
        })
        .default({}),
      skills_dir: z.string().optional(),
      ssh_config_path: z.string().optional(),
    })
    .default({}),
  agent: z
    .object({
      kind: AgentKindWithCustomSchema.default("claude"),
      command: z.string().optional(),
      model: z.string().optional(),
      max_concurrent_agents: z.number().default(10),
      max_concurrent_agents_by_state: z.record(z.string(), z.number()).default({}),
      // Forge Desktop: another intelligence provider and model for some stages (agent/roles.ts). The
      // role's account arrives in the environment under `env_prefix`.
      roles: z
        .array(
          z.object({
            states: z.array(z.string()).min(1),
            kind: AgentKindWithCustomSchema,
            model: z.string().optional(),
            env_prefix: z
              .string()
              .regex(/^FORGE_ROLE_\d+_$/)
              .optional(),
          }),
        )
        .default([]),
      max_turns: z.coerce.number().default(50),
      turn_timeout_ms: z.number().default(1_800_000),
      read_timeout_ms: z.number().default(480_000),
      // How long a lead may wait for its helpers after ending its turn (worker/helper-wait.ts).
      helper_wait_ms: z.number().default(3_600_000),
      stall_timeout_seconds: z.number().default(900),
      approval_policy: z.string().default("on-request"),
      max_retry_backoff_ms: z.number().default(300_000),
      // Env vars withheld from agent children and local workspace hooks
      // (FRG-4081): exact names or `*` globs, e.g. "*DATABASE_URL*". The
      // orchestrator keeps its own env. Empty => children inherit it all.
      // An all-`*` entry would strip PATH/HOME too, so each needs a literal char.
      env_denylist: z
        .array(z.string().regex(/[^*]/, "env_denylist entries need a non-* character"))
        .default([]),
    })
    .default({}),
  polling: z
    .object({
      interval_ms: z.number().default(30_000),
    })
    .default({}),
  // The app's board: its columns, in order (Forge Desktop).
  board: z
    .object({
      columns: z
        .array(z.string())
        .default([
          "Backlog",
          "Triage",
          "Todo",
          "In Progress",
          "AI Review",
          "QA",
          "Human Review",
          "Rework",
          "Merging",
          "Done",
        ]),
    })
    .default({}),
  // Per-build runaway-cost ceiling (FRG-958). max_build_usd <= 0 disables
  // enforcement (default), preserving prior unbounded behavior.
  cost: z
    .object({
      max_build_usd: z.coerce.number().default(0),
      input_usd_per_mtok: z.coerce.number().default(3),
      output_usd_per_mtok: z.coerce.number().default(15),
    })
    .default({}),
  retry: z
    .object({
      max_attempts: z.number().default(5),
      base_delay_seconds: z.number().default(10),
      max_delay_seconds: z.number().default(300),
    })
    .default({}),
  // Happy-path QA ticket guardrails (FRG-1718). Breach triggers the
  // `deployed_with_known_issues` terminal state when the app is still healthy.
  happy_path_qa: z
    .object({
      max_wallclock_min: z.number().default(180),
      max_attempts: z.number().default(50),
    })
    .default({}),
  server: z
    .object({
      port: z.number().int().optional(),
      host: z.string().optional(),
    })
    .default({}),
  // What others see (Forge Desktop, tracker/marks.ts): Workflow Studio's "Keep Forge invisible", the pull
  // request label (absent = `forge`, or none when invisible) and the branch prefix (empty = the tracker's name).
  marks: z
    .object({
      invisible: z.boolean().default(false),
      pr_label: z.string().optional(),
      branch_prefix: z
        .string()
        .regex(/^[A-Za-z0-9._/-]*$/, "a branch prefix may only hold letters, digits, . _ / and -")
        .default(""),
    })
    .default({}),
  observability: z
    .object({
      dashboard_enabled: z.boolean().default(true),
      refresh_ms: z.number().default(1000),
    })
    .default({}),
});

export type WorkflowConfig = z.infer<typeof WorkflowConfigSchema>;
