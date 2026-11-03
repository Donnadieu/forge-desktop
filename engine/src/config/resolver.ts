import { homedir } from "node:os";
import { resolve } from "node:path";
import { type WorkflowConfig, WorkflowConfigSchema } from "./schema.js";

/**
 * Resolve environment variables and paths in config values.
 *
 * - Recursively resolves $ENV_VAR and ${ENV_VAR} references in all string values
 * - Expands ~ to home directory in workspace.root
 * - Parses through Zod schema with defaults
 */
export function resolveConfig(raw: Record<string, unknown>): WorkflowConfig {
  const resolved = resolveEnvVars(raw, new Set(["hooks"])) as Record<string, unknown>;
  resolved.workspace = resolveWorkspacePaths(resolved.workspace as Record<string, unknown>);
  return WorkflowConfigSchema.parse(resolved);
}

function resolveEnvVars(obj: unknown, skipKeys: Set<string>, currentKey?: string): unknown {
  // Skip env var expansion inside hook scripts — the shell resolves those at runtime
  if (currentKey && skipKeys.has(currentKey)) return obj;

  if (typeof obj === "string") {
    const missingVars: string[] = [];
    const result = obj.replace(/\$\{([^}]+)\}|\$([A-Z_][A-Z0-9_]*)/g, (match, braced, bare) => {
      const varName = braced || bare;
      const value = process.env[varName];
      if (value === undefined) {
        missingVars.push(varName);
        return match;
      }
      return value;
    });
    if (missingVars.length > 0) {
      throw new Error(
        `Missing environment variable(s): ${missingVars.join(", ")}. Set them in .env or your shell environment.`,
      );
    }
    return result;
  }
  if (Array.isArray(obj)) return obj.map((v) => resolveEnvVars(v, skipKeys));
  if (obj && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = resolveEnvVars(value, skipKeys, key);
    }
    return result;
  }
  return obj;
}

function resolveWorkspacePaths(workspace: Record<string, unknown>): Record<string, unknown> {
  if (!workspace || typeof workspace !== "object") return workspace;
  if (typeof workspace.root === "string") {
    workspace.root = resolvePath(workspace.root);
  }
  return workspace;
}

export function resolvePath(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return resolve(homedir(), p.slice(2));
  }
  return resolve(p);
}
