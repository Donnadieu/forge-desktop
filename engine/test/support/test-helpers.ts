import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function createTempDir(prefix = "forge-test"): string {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function cleanupDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best effort cleanup
  }
}

export function writeWorkflowFile(
  dir: string,
  overrides: Record<string, unknown> = {},
  promptTemplate = "Fix {{ issue.identifier }}: {{ issue.title }}",
): string {
  const config = {
    tracker: {
      kind: "memory",
      project_slug: "test-project",
      active_states: ["Todo", "In Progress"],
      terminal_states: ["Done", "Closed"],
      ...((overrides.tracker as Record<string, unknown>) || {}),
    },
    workspace: {
      root: join(dir, "workspaces"),
      ...((overrides.workspace as Record<string, unknown>) || {}),
    },
    agent: {
      kind: "mock",
      max_concurrent_agents: 5,
      max_turns: 3,
      stall_timeout_seconds: 60,
      ...((overrides.agent as Record<string, unknown>) || {}),
    },
    polling: {
      interval_ms: 1000,
      ...((overrides.polling as Record<string, unknown>) || {}),
    },
    retry: {
      max_attempts: 3,
      base_delay_seconds: 1,
      max_delay_seconds: 10,
      ...((overrides.retry as Record<string, unknown>) || {}),
    },
  };

  // Build YAML frontmatter
  const yaml = buildYaml(config);
  const content = `---\n${yaml}---\n\n${promptTemplate}\n`;

  const filePath = join(dir, "WORKFLOW.md");
  writeFileSync(filePath, content);
  return filePath;
}

function buildYaml(obj: Record<string, unknown>, indent = 0): string {
  let result = "";
  const prefix = "  ".repeat(indent);

  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;

    if (Array.isArray(value)) {
      result += `${prefix}${key}:\n`;
      for (const item of value) {
        if (typeof item === "string" && item.includes(" ")) {
          result += `${prefix}  - "${item}"\n`;
        } else {
          result += `${prefix}  - ${item}\n`;
        }
      }
    } else if (typeof value === "object") {
      result += `${prefix}${key}:\n`;
      result += buildYaml(value as Record<string, unknown>, indent + 1);
    } else if (typeof value === "string" && value.includes(" ")) {
      result += `${prefix}${key}: "${value}"\n`;
    } else {
      result += `${prefix}${key}: ${value}\n`;
    }
  }

  return result;
}

/**
 * Wait for a condition to be true, polling at interval.
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 50,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await condition()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

/** Alive and not a zombie (an orphan can linger as `Z` until its reaper runs). */
export function isRunning(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2)[0] !== "Z";
  } catch {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}
