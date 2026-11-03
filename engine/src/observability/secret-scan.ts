/**
 * Fail-closed secret scanner for content about to leave the box (FRG-2081): the
 * TS twin of `scan_for_secret_values` in `scripts/stamp_scan.py`. The stamp
 * export runs the Python one; post-stamp Smith pushes (the global git
 * `pre-push` hook, `src/cli/pre-push-secret-scan.ts`, and the orchestrator's
 * build-report push) run this one. Both read the same `secret-spec.json`: exact
 * live env values, plus the narrow `scanPatterns` credential shapes whose key
 * body looks random.
 *
 * Security invariant: a hit names only the env var (`$NAME`) or the shape label,
 * never the value — the reason string is logged and printed to the agent.
 */

import { type LiveSecret, liveSecretEnv } from "./secret-redact.js";
import { SECRET_SPEC } from "./secret-spec.js";

const SCAN_PATTERNS: readonly { label: string; regex: RegExp }[] = SECRET_SPEC.scanPatterns.map(
  (p) => ({ label: p.label, regex: new RegExp(p.regex, "g") }),
);

// Mirrors `_MIN_SHAPE_DISTINCT_CHARS` / `_PLACEHOLDER_WORDS` in
// scripts/stamp_scan.py; secret-env-names-parity.test.ts runs both over one corpus.
const MIN_SHAPE_DISTINCT_CHARS = 8;
const PLACEHOLDER_WORDS = [
  "your",
  "here",
  "replace",
  "example",
  "placeholder",
  "insert",
  "dummy",
  "fake",
  "sample",
  "changeme",
  "token",
  "secret",
  "xxxx",
];

/**
 * A captured shape body counts as a live key only if it looks random: enough
 * distinct chars, a letter, a digit or mixed case, and no placeholder word. A
 * false positive here wedges a legitimate push, so `.env.example` text passes.
 */
export function looksLikeLiveCredential(body: string): boolean {
  const low = body.toLowerCase();
  const mixed = /\d/.test(body) || (/[A-Z]/.test(body) && /[a-z]/.test(body));
  return (
    new Set(body).size >= MIN_SHAPE_DISTINCT_CHARS &&
    /[A-Za-z]/.test(body) &&
    mixed &&
    !PLACEHOLDER_WORDS.some((w) => low.includes(w))
  );
}

/**
 * Return `"<path>: <reason>"` if `data` carries a live secret, else `null`.
 * Exact values match raw bytes (binary included); shapes only match text.
 */
export function scanContentForSecrets(
  path: string,
  data: Buffer,
  known: readonly LiveSecret[],
): string | null {
  for (const { name, value } of known) {
    if (data.includes(value)) return `${path}: matches a known secret value ($${name})`;
  }
  if (data.subarray(0, 8192).includes(0)) return null; // binary — exact values only
  const text = data.toString("utf-8");
  for (const { label, regex } of SCAN_PATTERNS) {
    for (const m of text.matchAll(regex)) {
      if (m[1] && looksLikeLiveCredential(m[1])) return `${path}: contains a ${label}`;
    }
  }
  return null;
}

/** Scan files in order; the first hit wins. The env is snapshotted once. */
export function scanFilesForSecrets(
  files: Iterable<{ path: string; data: Buffer }>,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const known = liveSecretEnv(env);
  for (const { path, data } of files) {
    const hit = scanContentForSecrets(path, data, known);
    if (hit) return hit;
  }
  return null;
}
