/**
 * Canonical boolean coercion for environment tokens.
 *
 * Lives in its own neutral module so the central env schema (`booleanFlag` in
 * env.ts) and feature gates (e.g. the custom_workflows gate) both depend on it,
 * and every reader agrees on exactly which spellings count as true/false. This
 * is the one place the coercion is defined; every new boolean-env reader should
 * route through it rather than re-implementing an inline `=== "true"` check (a
 * handful of older call sites still do — see FRG-2005 — and are being migrated
 * over).
 */

/** The canonical truthy spellings. Exported so cross-language mirrors can be pinned to it. */
export const BOOLEAN_TRUE_TOKENS = ["1", "true", "on", "yes"] as const;

/** The canonical falsy spellings (same export rationale). */
export const BOOLEAN_FALSE_TOKENS = ["0", "false", "off", "no"] as const;

const TRUTHY = new Set<string>(BOOLEAN_TRUE_TOKENS);
const FALSY = new Set<string>(BOOLEAN_FALSE_TOKENS);

function normalize(raw: string | undefined): string {
  return (raw ?? "").trim().toLowerCase();
}

/**
 * Coerce a raw env token to a boolean, or `undefined` when it is not a recognised
 * boolean spelling (so callers can apply their own default for the empty/unset case).
 */
export function parseBooleanToken(raw: string | undefined): boolean | undefined {
  const s = normalize(raw);
  if (TRUTHY.has(s)) return true;
  if (FALSY.has(s)) return false;
  return undefined;
}
