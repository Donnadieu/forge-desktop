import matter from "gray-matter";
import { type ZodTypeAny, z } from "zod";
import { WorkflowConfigSchema } from "./schema.js";

/**
 * Checks a workflow file someone edited by hand (Workflow Studio's "Edit workflow file") before the app saves
 * it: the settings block must read as YAML, every key must be one the engine knows, and each value the kind
 * it expects. Problems come back in plain words with the line they're on; the app never saves a file with
 * any. New in Forge Desktop.
 */
export interface WorkflowProblem {
  line: number;
  message: string;
}

/** Peel defaults, optionals and refinements off a schema to the shape underneath. */
function unwrap(t: ZodTypeAny): ZodTypeAny {
  let cur = t;
  for (;;) {
    if (cur instanceof z.ZodDefault) cur = cur._def.innerType;
    else if (cur instanceof z.ZodOptional || cur instanceof z.ZodNullable) cur = cur.unwrap();
    else if (cur instanceof z.ZodEffects) cur = cur.innerType();
    else return cur;
  }
}

/** Edit distance, for "did you mean". */
function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
  return d[a.length][b.length];
}

/** Every word of `key` is in `known` (`max_agents` → `max_concurrent_agents`). */
function sameWords(key: string, known: string): boolean {
  const words = new Set(known.split("_"));
  return key.split("_").every((w) => words.has(w));
}

function suggestion(key: string, known: string[]): string {
  const best = known
    .map((k) => ({
      k,
      d: k.includes(key) || key.includes(k) || sameWords(key, k) ? 1 : distance(key, k),
    }))
    .sort((x, y) => x.d - y.d)[0];
  return best && best.d <= Math.max(2, Math.floor(key.length / 3))
    ? ` Did you mean ${best.k}?`
    : "";
}

/** Every key path the file has that the schema doesn't, with the keys allowed in its place. */
function unknownKeys(
  value: unknown,
  schema: ZodTypeAny,
  path: Array<string | number>,
  out: Array<{ path: Array<string | number>; known: string[] }>,
): void {
  const s = unwrap(schema);
  if (s instanceof z.ZodObject && value && typeof value === "object" && !Array.isArray(value)) {
    const shape = s.shape as Record<string, ZodTypeAny>;
    for (const [k, v] of Object.entries(value)) {
      if (k in shape) unknownKeys(v, shape[k], [...path, k], out);
      else out.push({ path: [...path, k], known: Object.keys(shape) });
    }
  } else if (s instanceof z.ZodArray && Array.isArray(value)) {
    for (const [i, v] of value.entries()) unknownKeys(v, s.element, [...path, i], out);
  } else if (s instanceof z.ZodRecord && value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) unknownKeys(v, s._def.valueType, [...path, k], out);
  }
}

/** The 1-based file line a key path sits on (its nearest written parent when the key itself isn't there). */
function lineOf(lines: string[], path: Array<string | number>): number {
  let at = 1; // the opening ---
  let indent = -1;
  for (const seg of path) {
    if (typeof seg === "number") continue;
    for (let i = at; i < lines.length; i++) {
      const m = /^(\s*)(?:-\s+)?["']?([^"':#\s][^"':#]*?)["']?\s*:(?:\s|$)/.exec(lines[i]);
      if (!m) continue;
      const ind = m[1].length;
      if (ind <= indent && lines[i].trim() !== "") break;
      if (m[2] === seg && ind > indent) {
        at = i + 1;
        indent = ind;
        break;
      }
    }
  }
  return Math.max(1, at);
}

function kind(v: unknown): string {
  if (Array.isArray(v)) return "a list";
  if (v === null) return "empty";
  if (typeof v === "object") return "a group of settings";
  if (typeof v === "string") return "text";
  return `a ${typeof v}`;
}

/** Problems with a workflow file's text; an empty list means the engine will read it. */
export function checkWorkflowText(text: string): WorkflowProblem[] {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") {
    return [{ line: 1, message: "The file must start with its settings between two --- lines." }];
  }
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end < 0) return [{ line: 1, message: "The settings block has no closing --- line." }];
  const problems: WorkflowProblem[] = [];
  for (let i = 1; i < end; i++) {
    if (/^\s*\t/.test(lines[i])) {
      problems.push({
        line: i + 1,
        message: "This line is indented with a tab. The settings block needs spaces.",
      });
    }
  }
  if (problems.length > 0) return problems;
  let data: Record<string, unknown>;
  let body: string;
  try {
    // A fresh parse every time: gray-matter caches by content, and a cached result hides a fixed error.
    const parsed = matter(text, { delimiters: "---" });
    data = (parsed.data ?? {}) as Record<string, unknown>;
    body = parsed.content;
  } catch (err) {
    const e = err as { mark?: { line?: number }; reason?: string; message?: string };
    const line = (e.mark?.line ?? 0) + 2;
    return [
      {
        line,
        message: `The settings can't be read here: ${e.reason ?? e.message ?? "not valid YAML"}.`,
      },
    ];
  }
  const unknown: Array<{ path: Array<string | number>; known: string[] }> = [];
  unknownKeys(data, WorkflowConfigSchema, [], unknown);
  for (const u of unknown) {
    const key = String(u.path[u.path.length - 1]);
    problems.push({
      line: lineOf(lines, u.path),
      message: `${key} isn't a setting Forge knows.${suggestion(key, u.known)}`,
    });
  }
  const result = WorkflowConfigSchema.safeParse(data);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const key = issue.path.map(String).join(".") || "the settings";
      const message =
        issue.code === "invalid_type"
          ? issue.received === "undefined"
            ? `${key} is missing. The engine needs it.`
            : `${key} should be ${issue.expected === "array" ? "a list" : issue.expected === "object" ? "a group of settings" : `a ${issue.expected}`}, not ${kind(issue.path.reduce<unknown>((o, k) => (o as Record<string | number, unknown>)?.[k], data))}.`
          : `${key}: ${issue.message}.`;
      problems.push({ line: lineOf(lines, issue.path), message });
    }
  }
  if (!body.trim())
    problems.push({ line: end + 1, message: "The instructions after the settings are empty." });
  return problems.sort((a, b) => a.line - b.line);
}
