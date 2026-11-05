import { parseEnv } from "./env.js";
import type { WorkflowConfig } from "./schema.js";

/**
 * Env vars that forge injects at runtime — users don't need to set these.
 */
const SYSTEM_PROVIDED_VARS = new Set([
  "WORKSPACE_PATH",
  "ISSUE_ID",
  "ISSUE_IDENTIFIER",
  "ISSUE_TITLE",
  "ISSUE_STATE",
  "ISSUE_BRANCH",
]);

/**
 * Validate that all required environment variables are set before starting.
 * Checks tracker-specific vars and scans hook scripts for referenced env vars.
 * Throws with a clear, actionable error listing every missing variable.
 */
export function validateRequiredEnv(config: WorkflowConfig): void {
  const missing: string[] = [];
  // Re-parse through the central schema so tests that mutate `process.env`
  // see current values; in production this is called after `getEnv()` has
  // already validated the shape at boot.
  const env = parseEnv();

  // Tracker-specific requirements (read through the central env schema so
  // invalid values were already caught at boot; here we just check presence).
  if (config.tracker.kind === "linear" && !env.LINEAR_API_KEY) {
    missing.push("LINEAR_API_KEY (required for tracker: linear)");
  }
  if (config.tracker.kind === "basecamp") {
    // Forge Desktop: the app's token command (FORGE_BASECAMP_TOKEN_COMMAND) or a fixed key.
    if (!env.FORGE_BASECAMP_API_KEY && !env.FORGE_BASECAMP_TOKEN_COMMAND) {
      missing.push(
        "FORGE_BASECAMP_TOKEN_COMMAND or FORGE_BASECAMP_API_KEY (required for tracker: basecamp)",
      );
    }
    if (!config.tracker.account_id) {
      missing.push("tracker.account_id (required in WORKFLOW.md for tracker: basecamp)");
    }
  }

  // Scan hook scripts for env var references
  const hooks = config.workspace.hooks;
  for (const [hookName, value] of Object.entries(hooks)) {
    if (typeof value !== "string") continue;
    for (const varName of extractEnvVarRefs(value)) {
      if (!process.env[varName]) {
        missing.push(`${varName} (referenced in hook: ${hookName})`);
      }
    }
  }

  if (missing.length > 0) {
    const list = missing.map((v) => `  - ${v}`).join("\n");
    throw new Error(
      `Missing required environment variables:\n${list}\n\nSet them in .env or your shell environment.`,
    );
  }
}

/**
 * Parse the body of a `${...}` expansion and decide whether the referenced
 * variable is required. Bash operators that supply a fallback (`:-`, `:=`,
 * `:+`, `#`, `##`, `%`, `%%`, `/...`) mean the script will not fail when the
 * variable is unset, so we treat those references as optional. Only `:?` and
 * bare references (`${VAR}`, `$VAR`) are considered required.
 */
function parseBracedVarRef(body: string): { name: string; required: boolean } | null {
  const nameMatch = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(body);
  if (!nameMatch) return null;
  const name = nameMatch[1];
  const rest = body.slice(name.length);

  if (rest === "") {
    return { name, required: true };
  }

  // Colon-prefixed operators.
  if (rest.startsWith(":")) {
    const op = rest.slice(1, 2);
    if (op === "-" || op === "=" || op === "+") {
      return { name, required: false };
    }
    if (op === "?") {
      return { name, required: true };
    }
    // Unknown `:` operator (e.g. substring `${VAR:offset}`) — keep conservative.
    return { name, required: true };
  }

  // Non-colon operators that provide a fallback/empty expansion.
  if (rest.startsWith("-") || rest.startsWith("=") || rest.startsWith("+")) {
    return { name, required: false };
  }
  if (rest.startsWith("?")) {
    return { name, required: true };
  }
  if (rest.startsWith("#") || rest.startsWith("%") || rest.startsWith("/")) {
    return { name, required: false };
  }

  // Unknown trailing content — keep the valid name and treat as required.
  return { name, required: true };
}

/**
 * Collect variable names the script assigns to *itself*. A hook that computes
 * a value into a local variable and then reads it back (e.g. the stamped-repo
 * handoff block: `_stamped_repo="$(cat ...)"; ... git remote ... "$_stamped_url"`)
 * is self-contained — those `$VAR` reads are not external inputs and must not be
 * flagged as required env vars. Recognizes plain assignments (`NAME=...`),
 * `export`/`local`/`declare`/`readonly NAME=...`, and `read [-r] NAME ...`.
 */
function extractAssignedVars(script: string): Set<string> {
  const assigned = new Set<string>();
  const name = "[A-Za-z_][A-Za-z0-9_]*";
  // Assignment at a statement boundary: start of line, or after a shell
  // separator (; & | newline) or a compound-keyword (do/then/else/{), with an
  // optional export/local/declare/readonly qualifier. Requires `=` (not `==`).
  const assignRe = new RegExp(
    `(?:^|[;&|\\n{]|\\b(?:do|then|else)\\b)\\s*(?:(?:export|local|declare|readonly)\\s+)?(${name})=(?!=)`,
    "g",
  );
  for (let m = assignRe.exec(script); m !== null; m = assignRe.exec(script)) {
    assigned.add(m[1]);
  }
  // `read [-flags] NAME [NAME...]` binds each listed name.
  const readRe = new RegExp(`\\bread\\b(?:\\s+-\\S+)*((?:\\s+${name})+)`, "g");
  for (let m = readRe.exec(script); m !== null; m = readRe.exec(script)) {
    for (const n of m[1].trim().split(/\s+/)) assigned.add(n);
  }
  return assigned;
}

/**
 * Extract env var references ($VAR / ${VAR}) from a shell script string,
 * excluding system-provided variables that forge injects at runtime,
 * variables that have a bash fallback expansion, and variables the script
 * assigns to itself (hook-local scratch variables).
 */
export function extractEnvVarRefs(script: string): string[] {
  const assigned = extractAssignedVars(script);
  const required = new Set<string>();
  const regex = /\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;
  for (let match = regex.exec(script); match !== null; match = regex.exec(script)) {
    if (match[2]) {
      // $VAR form
      if (!SYSTEM_PROVIDED_VARS.has(match[2]) && !assigned.has(match[2])) {
        required.add(match[2]);
      }
      continue;
    }

    const body = match[1];
    if (!body) continue;
    const parsed = parseBracedVarRef(body);
    if (parsed?.required && !SYSTEM_PROVIDED_VARS.has(parsed.name) && !assigned.has(parsed.name)) {
      required.add(parsed.name);
    }
  }
  return [...required];
}
