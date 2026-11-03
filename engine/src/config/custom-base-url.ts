/**
 * Owner-supplied SDK roots (FRG-2089, FRG-4318): the per-app `smith_base_url`
 * and the BYOK vault's `base_url`. Re-exported from `providers.ts`.
 */

/** Longest owner-supplied base URL accepted (FRG-2089). */
export const MAX_CUSTOM_BASE_URL_LEN = 500;

/**
 * An owner-supplied SDK root (`apps.smith_base_url`, FRG-2089). HTTPS only; a
 * bare hostname (no userinfo, query or fragment) plus plain path segments, so
 * the value is safe as a `flyctl secrets import` NAME=VALUE line and inside the
 * double-quoted YAML scalar start-forgesmith.sh renders it into. Mirror of
 * `_CUSTOM_BASE_URL_RE` in scripts/provider_registry.py — same regex, same
 * vectors (providers-lockstep.test.ts).
 */
const CUSTOM_BASE_URL =
  /^https:\/\/[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::[0-9]{1,5})?(?:\/[A-Za-z0-9._~-]+)*\/?$/;

/** The URL trimmed and without its trailing slash, or null if it is empty or
 *  not a plain `https://` URL. Mirror of `clean_custom_base_url`. */
export function cleanCustomBaseUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // ASCII whitespace only — String.trim() and Python's str.strip() disagree on
  // the rest (U+FEFF, \x1c-\x1f, U+0085), and the regex rejects them anyway.
  const value = raw.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
  if (value.length > MAX_CUSTOM_BASE_URL_LEN || !CUSTOM_BASE_URL.test(value)) return null;
  const root = value.replace(/\/$/, "");
  // Must be an OpenAI-wire SDK root: the MCP router speaks OpenAI to it, while
  // Hermes switches to Anthropic Messages for a URL ending in `/anthropic` —
  // the planner would work and every sizing call would fail.
  return root.toLowerCase().endsWith("/anthropic") ? null : root;
}
