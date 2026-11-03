/**
 * Canonical TS secret redactor (FRG-2075, BYOK T11). One owner of "what a secret
 * looks like" so every TS sink — the pino logger (`logger.ts`), the committed
 * build report (`orchestrator/build-report.ts`) and `run.json`
 * (`pipeline/repo-creator-utils.ts`), worker Linear writes
 * (`mcp/linear-graphql-server.ts`) and git error text (`services/repo-import.ts`)
 * — scrubs the same shapes and the same env values with the same length gate.
 * Shapes, gate and placeholder come from `secret-spec.json`, which the Python
 * side (`scripts/secret_spec.py`) loads too (FRG-2082).
 */

import { SECRET_VALUE_ENV_NAMES } from "./secret-env-names.js";
import { SECRET_SPEC } from "./secret-spec.js";

export const REDACTION = SECRET_SPEC.placeholder;

/**
 * Generic secret-shaped token patterns (the spec's `redactPatterns`). Anchored
 * to prefixes/lengths that only real credentials hit, so ordinary prose ("the
 * sky is blue") is never touched. Apply them to individual strings (see
 * `redactSecretsDeep`), never to serialized JSON — the DSN pattern can consume
 * a `\"` escape.
 */
const SECRET_TOKEN_PATTERNS: readonly RegExp[] = SECRET_SPEC.redactPatterns.map(
  (p) => new RegExp(p.regex, "g"),
);

// A live env value must be at least this long to be redacted by exact match —
// short/flag values ("1", "true") would clobber innocent text.
export const MIN_ENV_VALUE_LEN = SECRET_SPEC.minValueLength;

/**
 * Replace every secret-shaped token (and every live secret env value) in a string.
 *
 * The exact env-value pass only fires for secrets present in `env` (the local
 * process env by default). The orchestrator runs ON the build worker, whose env
 * holds the BYOK customer key, so worker-side logs and the build report do
 * exact-match it; factory-side sinks never see that key in their env, so their
 * coverage falls to `SECRET_TOKEN_PATTERNS` — which is why the shape library is
 * kept broad.
 */
export function redactSecretsFromString(
  input: string,
  env: NodeJS.ProcessEnv = process.env,
  extraValues: readonly (string | null | undefined)[] = [],
): string {
  return redactWithValues(input, liveSecretValues(env, extraValues));
}

// The live secret values worth exact-matching: every secret env value long
// enough to pass the gate, plus any caller-held secret not in the env (e.g. a
// user's GitHub token) at any non-empty length. Longest first, so a secret that
// contains another is replaced whole. Resolved once per top-level scrub (not
// per string leaf) — a log call with many leaves pays for it once.
function liveSecretValues(
  env: NodeJS.ProcessEnv,
  extraValues: readonly (string | null | undefined)[] = [],
): string[] {
  const values = liveSecretEnv(env).map((s) => s.value);
  for (const raw of extraValues) {
    const value = raw?.trim();
    if (value) values.push(value);
  }
  return values.sort((a, b) => b.length - a.length);
}

/** A live secret env var: its NAME (safe to surface) and its VALUE (never). */
export interface LiveSecret {
  name: string;
  value: string;
}

/**
 * Every secret env var whose trimmed value passes the exact-match length gate.
 * Snapshot it once per scrub or scan, not per string or file. Mirrors
 * `live_secrets` in `scripts/secret_spec.py`.
 */
export function liveSecretEnv(env: NodeJS.ProcessEnv = process.env): LiveSecret[] {
  const out: LiveSecret[] = [];
  for (const name of SECRET_VALUE_ENV_NAMES) {
    const value = env[name]?.trim();
    if (value && value.length >= MIN_ENV_VALUE_LEN) out.push({ name, value });
  }
  return out;
}

function redactWithValues(input: string, values: readonly string[]): string {
  let out = input;
  // Exact live-value matches first (highest precision).
  for (const value of values) {
    if (out.includes(value)) out = out.split(value).join(REDACTION);
  }
  for (const pattern of SECRET_TOKEN_PATTERNS) {
    out = out.replace(pattern, REDACTION);
  }
  return out;
}

// Recursion guard: anything nested deeper than this is replaced rather than
// walked, so a pathological object can never blow the stack of a log call.
const MAX_DEPTH = 32;

/**
 * Deep-scrub every string leaf of an arbitrary value. Recurses into plain
 * objects, arrays, and Errors. An Error is copied (see `scrubError`) with its
 * `message`, `stack`, `cause`, and custom fields scrubbed: a thrown error
 * echoing a tokenized URL or env dump is the most common leak vector.
 * Class instances with a `toJSON` (URL, Date, …) are scrubbed in their JSON form;
 * other class instances are returned untouched. Cycles become
 * `"[Circular]"` (matching pino's own rendering) instead of recursing forever.
 */
export function redactSecretsDeep<T>(value: T, env: NodeJS.ProcessEnv = process.env): T {
  return scrub(value, liveSecretValues(env), new WeakSet(), 0) as T;
}

function scrub(
  value: unknown,
  values: readonly string[],
  seen: WeakSet<object>,
  depth: number,
): unknown {
  if (typeof value === "string") return redactWithValues(value, values);
  if (!value || typeof value !== "object") return value;
  const isError = value instanceof Error;
  const proto = Object.getPrototypeOf(value);
  const isPlain = Array.isArray(value) || proto === Object.prototype || proto === null;
  if (!isError && !isPlain) return scrubJsonable(value, values, seen, depth);
  if (seen.has(value)) return "[Circular]";
  if (depth >= MAX_DEPTH) return "[MaxDepth]";
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((v) => scrub(v, values, seen, depth + 1));
    const src = value as Record<string, unknown>;
    if (isError) return scrubError(value, values, seen, depth);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src)) out[key] = scrub(src[key], values, seen, depth + 1);
    return out;
  } finally {
    // Only ancestors count as cycles — a shared (non-circular) reference seen
    // again in a sibling branch is still scrubbed, not collapsed.
    seen.delete(value);
  }
}

// Class instances that serialize via `toJSON` (`URL`, `Date`, …) are replaced by
// their scrubbed JSON form — what pino would emit anyway — so a credentialed URL
// is scrubbed and pino's `redact.paths` walk never touches the exotic object
// (a `URL`'s private fields make it throw). Anything else passes through as-is.
function scrubJsonable(
  value: object,
  values: readonly string[],
  seen: WeakSet<object>,
  depth: number,
): unknown {
  const toJSON = (value as { toJSON?: unknown }).toJSON;
  if (typeof toJSON !== "function") return value;
  if (depth >= MAX_DEPTH) return "[MaxDepth]";
  let json: unknown;
  try {
    json = toJSON.call(value);
  } catch {
    return value;
  }
  return json === value ? value : scrub(json, values, seen, depth + 1);
}

// Read an Error property without letting a hostile/brand-checked getter throw
// (DOMException's `name`/`message`/`code` getters throw on a foreign receiver).
function safeGet(err: Error, key: string): unknown {
  try {
    return (err as unknown as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/**
 * Copy an Error into a fresh `Error` carrying scrubbed PLAIN data properties.
 * Values are read from the original (so prototype/own getters such as
 * DOMException's `message` or Node 22's own `stack` accessor resolve against
 * the real receiver) and written as plain values — the copy never re-runs a
 * getter on the wrong `this`. The copy's prototype is the original's when it
 * descends from `Error.prototype` via ordinary constructors, so `instanceof`
 * and pino's `err` serializer (which reads `constructor.name`) keep working.
 */
function scrubError(
  err: Error,
  values: readonly string[],
  seen: WeakSet<object>,
  depth: number,
): Error {
  const copy = new Error();
  const keys = new Set<string>(["name", "message", "stack", ...Object.getOwnPropertyNames(err)]);
  if ("cause" in err) keys.add("cause");
  for (const key of keys) {
    const v = safeGet(err, key);
    if (v === undefined) continue;
    Object.defineProperty(copy, key, {
      value: scrub(v, values, seen, depth + 1),
      writable: true,
      enumerable: key !== "stack" && key !== "message" && key !== "name",
      configurable: true,
    });
  }
  Object.setPrototypeOf(copy, safeErrorProto(err));
  return copy;
}

// The original's prototype, unless its chain (below Error.prototype) defines
// accessors — e.g. DOMException's brand-checked `message`/`code` getters, which
// pino's `for…in` serializer would invoke on the copy and throw. Those fall
// back to Error.prototype; the scrubbed `name` own-property keeps the type.
function safeErrorProto(err: Error): object {
  const original = Object.getPrototypeOf(err) as object | null;
  for (let p = original; p && p !== Error.prototype; p = Object.getPrototypeOf(p)) {
    for (const key of Object.getOwnPropertyNames(p)) {
      if (Object.getOwnPropertyDescriptor(p, key)?.get) return Error.prototype;
    }
  }
  return original ?? Error.prototype;
}
