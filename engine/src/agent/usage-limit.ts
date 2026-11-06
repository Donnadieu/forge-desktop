/**
 * Usage limits (Forge Desktop): reads an agent's failure text and says whether its account hit a usage, spend or
 * rate limit, the reason in plain words, and when it resets. Every pattern is a provider's own text, recorded from
 * runs or copied from its source (the tests keep one recorded line for each):
 * - Claude Code 2.1.318: `You've hit your <limit>` + ` · resets 11:40pm (America/New_York)`; limit names from its
 *   source (5-hour, weekly, Opus, Sonnet, Fable, individual spend, org's monthly spend, team's shared budget...),
 *   `You're out of usage credits`, and the API's `Rate limit exceeded` (API status 429).
 * - Codex 0.153 (`codex-rs/protocol/src/error.rs`): `You've hit your usage limit... Try again at 3:45 PM.`,
 *   `You hit your spend cap...`, `Your workspace is out of credits...`, `Quota exceeded. Check your plan and billing
 *   details.`, `rate limit exceeded: ...`.
 * - OpenRouter (through Claude Code; docs.openrouter.ai Limits): 402 `...exceed your available credits...`, 403
 *   `Org member budget limit exceeded (...). Contact your org admin. ...; resets 2026-10-12T00:00:00.000Z.`, 429
 *   `Rate limit exceeded`.
 * - Kimi (kimi-cli 0.80 prints the API's error; platform.kimi.ai errors): `exceeded_current_quota_error`,
 *   `rate_limit_reached_error`. `engine_overloaded_error` is the service's capacity, not the account's: not a limit.
 *
 * New in Forge Desktop.
 */

export type LimitKind = "five_hour" | "weekly" | "usage" | "spend" | "credits" | "rate";

export interface UsageLimit {
  kind: LimitKind;
  /** The reason in plain words: "5-hour limit", "spend limit, ask your admin to raise it". */
  reason: string;
  /** When the provider said it resets (ISO 8601), or null when it didn't say. */
  resetsAt: string | null;
  /** The page the error names for raising the limit, if it names one. */
  link: string | null;
}

const ADMIN = /ask your admin|contact your admin|org admin|ask an owner|ask your workspace owner/i;

interface Rule {
  test: RegExp;
  kind: LimitKind;
  reason: (text: string) => string;
}

const spendReason = (t: string): string =>
  ADMIN.test(t) ? "spend limit, ask your admin to raise it" : "spend limit";

/** First match wins: the specific texts before the generic ones (a spend limit also carries "429"). */
const RULES: Rule[] = [
  // Claude Code: individual / org / channel spend and usage limits, a team's shared budget.
  {
    test: /You've hit your (?:individual|org's monthly|monthly|channel's monthly) (?:spend|usage) limit|You've hit your team's shared budget/,
    kind: "spend",
    reason: spendReason,
  },
  // Codex: a workspace spend cap. OpenRouter: an org, workspace or key budget.
  { test: /You hit your spend cap|budget limit exceeded/i, kind: "spend", reason: spendReason },
  {
    test: /You've hit your (?:5-hour|session) limit/,
    kind: "five_hour",
    reason: () => "5-hour limit",
  },
  {
    test: /You've hit your (?:weekly|Opus|Sonnet|Fable) limit|You've reached your Fable limit/,
    kind: "weekly",
    reason: () => "weekly limit",
  },
  {
    test: /You're out of usage credits|Your org is out of usage|You've hit your usage credit limit|Your workspace is out of credits|Quota exceeded\. Check your plan and billing details|exceed your available credits|insufficient credits|exceeded_current_quota_error|Quota exceeded, please upgrade your plan|Token quota is insufficient|Account balance is insufficient/i,
    kind: "credits",
    reason: (t) => (ADMIN.test(t) ? "out of credits, ask your admin for more" : "out of credits"),
  },
  // Codex (and Claude Code's generic case): the plan's usage limit.
  { test: /You've hit your usage limit/, kind: "usage", reason: () => "usage limit" },
  {
    test: /rate_limit_reached_error|rate_limit_error|rate limit exceeded|Error code: 429|API Error: 429|\(API status 429\)/i,
    kind: "rate",
    reason: () => "rate limit",
  },
];

/** The service is busy (Kimi's 429, Anthropic's 529): retried as usual, never a limit on the account. */
const OVERLOADED = /overloaded/i;

/** Reads a failure text; null when it isn't a usage, spend or rate limit. */
export function detectUsageLimit(
  text: string | null | undefined,
  now = new Date(),
): UsageLimit | null {
  if (!text) return null;
  const rule = RULES.find((r) => r.test.test(text));
  if (!rule) return null;
  if (rule.kind === "rate" && OVERLOADED.test(text)) return null;
  const link = /https:\/\/\S+?(?=[\s)·,]|$)/.exec(text)?.[0] ?? null;
  return { kind: rule.kind, reason: rule.reason(text), resetsAt: parseResetTime(text, now), link };
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * The reset time a limit text gives, as ISO 8601. Understands Claude Code's `resets 11:40pm (America/New_York)`
 * and `resets Nov 10, 3pm (America/New_York)`, Codex's `Try again at 3:45 PM.` and `Try again at Nov 12th, 2026
 * 3:45 PM.` (this Mac's time zone), and OpenRouter's `resets 2026-10-12T00:00:00.000Z`.
 */
export function parseResetTime(text: string, now = new Date()): string | null {
  const iso = /resets (?:at )?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z)/.exec(text);
  if (iso) {
    const t = Date.parse(iso[1]);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }
  const claude =
    /resets ((?:[A-Z][a-z]{2} \d{1,2},? (?:\d{4},? )?)?\d{1,2}(?::\d{2})?\s?[ap]m)(?: \(([^)]+)\))?/i.exec(
      text,
    );
  const codex = claude
    ? null
    : /try again at ((?:[A-Z][a-z]{2} \d{1,2}(?:st|nd|rd|th)?,? \d{4},? )?\d{1,2}:\d{2}\s?[AP]M)/i.exec(
        text,
      );
  const hit = claude ?? codex;
  if (!hit) return null;
  const t = wallClock(hit[1], claude?.[2], now);
  return t === null ? null : new Date(t).toISOString();
}

/** A wall-clock time ("11:40pm", "Nov 10, 3pm") in `zone` (default: this Mac's) as epoch ms: the next one from now. */
function wallClock(s: string, zone: string | undefined, now: Date): number | null {
  const m =
    /^(?:([A-Z][a-z]{2}) (\d{1,2})(?:st|nd|rd|th)?,? (?:(\d{4}),? )?)?(\d{1,2})(?::(\d{2}))?\s?([ap]m)$/i.exec(
      s.trim(),
    );
  if (!m) return null;
  const tz = validZone(zone);
  let hour = Number(m[4]) % 12;
  if (m[6].toLowerCase() === "pm") hour += 12;
  const minute = m[5] ? Number(m[5]) : 0;
  const today = partsIn(now.getTime(), tz);
  if (m[1]) {
    const month = MONTHS.indexOf(m[1].toLowerCase());
    if (month < 0) return null;
    const year = m[3] ? Number(m[3]) : today.year;
    let t = zonedToEpoch(year, month, Number(m[2]), hour, minute, tz);
    if (!m[3] && t < now.getTime() - 86_400_000)
      t = zonedToEpoch(year + 1, month, Number(m[2]), hour, minute, tz);
    return t;
  }
  let t = zonedToEpoch(today.year, today.month, today.day, hour, minute, tz);
  // A time already past today means tomorrow's.
  if (t < now.getTime() - 60_000)
    t = zonedToEpoch(today.year, today.month, today.day + 1, hour, minute, tz);
  return t;
}

function validZone(zone: string | undefined): string | undefined {
  if (!zone) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return undefined;
  }
}

function partsIn(t: number, tz: string | undefined) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
  const p = Object.fromEntries(f.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return {
    year: Number(p.year),
    month: Number(p.month) - 1,
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    second: Number(p.second),
  };
}

/** Epoch ms of a wall-clock time in `tz` (month 0-based; a day past the month's end rolls over). */
function zonedToEpoch(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  tz: string | undefined,
): number {
  const guess = Date.UTC(y, mo, d, h, mi);
  const offset = (t: number) => {
    const p = partsIn(t, tz);
    return (
      Date.UTC(p.year, p.month, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000
    );
  };
  let t = guess - offset(guess);
  const again = guess - offset(t);
  if (again !== t) t = again;
  return t;
}
