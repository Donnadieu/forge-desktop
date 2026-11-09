import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "../../src");

/**
 * Allowed cross-module dependencies, matching docs/ARCHITECTURE.md (engine layers).
 * The same layer map as Forge's engine, minus the web platform.
 *
 * Layer 0 (Foundation): config, observability, process, telemetry, agent/types, tracker/types
 * Layer 1 (Infrastructure): workspace, agent (impls), tracker (impls), mcp (Linear tools for agents),
 *   store (the engine's local SQLite file)
 * Layer 2 (Execution): worker
 * Layer 3 (Coordination): orchestrator, then server (the local API the app talks to), sessions (chats)
 * Layer 4 (Entry): src/index.ts
 */
const ALLOWED_DEPS: Record<string, string[]> = {
  config: [],
  observability: ["config"],
  process: [],
  telemetry: ["tracker"],
  agent: ["process", "config"],
  tracker: ["observability"],
  mcp: ["tracker", "observability", "config"],
  store: [],
  workspace: ["tracker", "process"],
  worker: ["agent", "tracker", "workspace", "telemetry"],
  orchestrator: ["agent", "tracker", "workspace", "worker", "observability", "telemetry", "config"],
  server: ["orchestrator", "observability", "config", "store"],
  // The sessions host (chats with agents): beside the orchestrator, sharing the process tree, logger and API helpers.
  sessions: ["process", "observability", "server"],
};

/** Forge's web platform. None of it comes over (docs/ARCHITECTURE.md, "Never in the engine"). */
const WEB_PLATFORM = ["db", "services", "pipeline", "auth", "clients", "smith", "cli", "ui"];

function collectTsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...collectTsFiles(full));
    else if (entry.endsWith(".ts")) files.push(full);
  }
  return files;
}

function getModule(filePath: string): string | null {
  const parts = relative(SRC, filePath).split("/");
  return parts.length === 1 ? null : parts[0];
}

function stripTypeOnlyImports(content: string): string {
  return content
    .replace(/^\s*import\s+type\s+[^;]+;?\s*$/gm, "")
    .replace(/\btype\s+[\w$]+(?:\s+as\s+[\w$]+)?\s*,?\s*/g, "")
    .replace(/^\s*import\s*\{\s*\}\s*from\s+["'][^"']+["'];?\s*$/gm, "")
    .replace(/(import\s+[\w$]+\s*,\s*)\{\s*\}\s*from/g, "$1from");
}

function crossModuleImports(content: string, sourceModule: string): string[] {
  const importRegex = /from\s+["']((?:\.\.\/)+)([^/"']+)\//g;
  const found = new Set<string>();
  for (const match of stripTypeOnlyImports(content).matchAll(importRegex)) {
    if (match[2] !== sourceModule) found.add(match[2]);
  }
  return [...found];
}

describe("engine module boundaries", () => {
  const files = collectTsFiles(SRC);

  it("every cross-module import respects the layer map", () => {
    const violations: string[] = [];
    for (const file of files) {
      const mod = getModule(file);
      if (mod === null) continue;
      const allowed = ALLOWED_DEPS[mod];
      if (allowed === undefined) {
        violations.push(
          `UNKNOWN MODULE: ${relative(SRC, file)} is in "${mod}", which isn't in the layer map. ` +
            `FIX: add "${mod}" to ALLOWED_DEPS here and to docs/ARCHITECTURE.md, or move the file into an existing module.`,
        );
        continue;
      }
      for (const dep of crossModuleImports(readFileSync(file, "utf-8"), mod)) {
        if (!allowed.includes(dep)) {
          violations.push(
            `VIOLATION: ${relative(SRC, file)} imports from "${dep}" but ${mod} may only use [${allowed.join(", ")}]. ` +
              "FIX: move the shared type down a layer, or pass it in from the caller (docs/ARCHITECTURE.md).",
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("nothing from Forge's web platform comes over", () => {
    const present = WEB_PLATFORM.filter((m) => existsSync(join(SRC, m)));
    expect(
      present,
      "FIX: the web platform stays in Forge. Take only the folders in docs/ARCHITECTURE.md's import list.",
    ).toEqual([]);
  });

  it("the layer map has no cycles", () => {
    const seen = new Set<string>();
    const visiting = new Set<string>();
    const cycles: string[] = [];
    const visit = (m: string, path: string[]) => {
      if (visiting.has(m)) {
        cycles.push([...path, m].join(" -> "));
        return;
      }
      if (seen.has(m)) return;
      visiting.add(m);
      for (const d of ALLOWED_DEPS[m] ?? []) visit(d, [...path, m]);
      visiting.delete(m);
      seen.add(m);
    };
    for (const m of Object.keys(ALLOWED_DEPS)) visit(m, []);
    expect(cycles, "FIX: a lower layer must never depend on a higher one.").toEqual([]);
  });
});
