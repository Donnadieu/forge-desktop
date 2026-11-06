import { describe, expect, it } from "vitest";
import { detectUsageLimit, parseResetTime } from "../../../src/agent/usage-limit.js";

// 8:16 PM in New York on Nov 5, 2026, when the work account hit its spend limit.
const NOW = new Date("2026-11-06T01:16:00.000Z");

/**
 * Recorded texts. Claude Code's come from real runs on this Mac (Claude Code 2.1.318 transcripts and the engine's
 * retry queue, Nov 5 2026). Codex's are its `UsageLimitReachedError`/`CodexErr` Display strings (codex-rs 0.153.2
 * `protocol/src/error.rs`). OpenRouter's are the error bodies in its Limits docs, as Claude Code reports an API
 * error. Kimi's are kimi-cli 0.80's print-mode line (`Error code: <status> - <body>` from the openai client) with the
 * error types and messages from the Kimi API's error table.
 */
const RECORDED = {
  claudeFiveHour: "You've hit your 5-hour limit · resets 4:20pm (America/New_York)",
  claudeSpend:
    "You've hit your individual spend limit · ask your admin to raise it at https://claude.ai/admin-settings/usage · your 5-hour limit resets 11:40pm (America/New_York) (API status 429)",
  claudeWeekly: "You've hit your weekly limit · resets Nov 10, 3pm (America/New_York)",
  claudeOrgSpend:
    "You've hit your org's monthly spend limit · ask your admin to raise it at https://claude.ai/admin-settings/usage",
  claudeRate: "API Error: 429 Rate limit exceeded (API status 429)",
  codexUsage:
    "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 11:05 PM.",
  codexUsageLater: "You've hit your usage limit. Try again at Nov 12th, 2026 9:30 AM.",
  codexSpend:
    "You hit your spend cap set by the owner of your workspace. Ask an owner to increase your spend cap to continue.",
  codexQuota: "Quota exceeded. Check your plan and billing details.",
  codexRate:
    "rate limit exceeded: Rate limit reached for gpt-5 in organization org-x on tokens per min (TPM)",
  openrouterCredits:
    'API Error: 402 {"error":{"code":402,"message":"This request would exceed your available credits given your current in-flight requests. Retry after in-flight requests settle, or add credits."}}',
  openrouterBudget:
    'API Error: 403 {"error":{"code":403,"message":"Org member budget limit exceeded (weekly limit). Contact your org admin. $52.00 of $50.00 used; resets 2026-11-09T00:00:00.000Z."}}',
  openrouterRate: 'API Error: 429 {"error":{"code":429,"message":"Rate limit exceeded"}}',
  kimiQuota:
    "Kimi turn produced no events: Error code: 429 - {'error': {'message': 'Account balance is insufficient or the account has been disabled', 'type': 'exceeded_current_quota_error'}}",
  kimiRate:
    "Kimi turn produced no events: Error code: 429 - {'error': {'message': 'Your account 1234<ak-5678> request reached TPM rate limit, current:120000, limit:100000', 'type': 'rate_limit_reached_error'}}",
};

describe("usage limits from each provider's own words", () => {
  it("Claude Code's 5-hour limit, with its reset in New York time", () => {
    const l = detectUsageLimit(RECORDED.claudeFiveHour, new Date("2026-11-05T19:30:00.000Z"));
    expect(l).toMatchObject({ kind: "five_hour", reason: "5-hour limit" });
    expect(l?.resetsAt).toBe("2026-11-05T21:20:00.000Z");
  });

  it("Claude Code's individual spend limit: ask your admin, resets 11:40 PM", () => {
    const l = detectUsageLimit(RECORDED.claudeSpend, NOW);
    expect(l).toMatchObject({
      kind: "spend",
      reason: "spend limit, ask your admin to raise it",
      link: "https://claude.ai/admin-settings/usage",
    });
    expect(l?.resetsAt).toBe("2026-11-06T04:40:00.000Z");
  });

  it("Claude Code's weekly limit, with a date", () => {
    const l = detectUsageLimit(RECORDED.claudeWeekly, NOW);
    expect(l).toMatchObject({ kind: "weekly", reason: "weekly limit" });
    expect(l?.resetsAt).toBe("2026-11-10T20:00:00.000Z");
  });

  it("Claude Code's org spend limit gives no reset", () => {
    expect(detectUsageLimit(RECORDED.claudeOrgSpend, NOW)).toMatchObject({
      kind: "spend",
      reason: "spend limit, ask your admin to raise it",
      resetsAt: null,
    });
  });

  it("Claude's API rate limit", () => {
    expect(detectUsageLimit(RECORDED.claudeRate, NOW)).toMatchObject({
      kind: "rate",
      reason: "rate limit",
    });
  });

  it("Codex's usage limit, its spend cap, its quota and its rate limit", () => {
    const u = detectUsageLimit(RECORDED.codexUsage, NOW);
    expect(u).toMatchObject({ kind: "usage", reason: "usage limit" });
    // "try again at 11:05 PM" is this Mac's own time.
    const reset = new Date(u?.resetsAt ?? "");
    expect([reset.getHours(), reset.getMinutes()]).toEqual([23, 5]);
    const later = new Date(detectUsageLimit(RECORDED.codexUsageLater, NOW)?.resetsAt ?? "");
    expect([later.getFullYear(), later.getMonth(), later.getDate(), later.getHours()]).toEqual([
      2026, 10, 12, 9,
    ]);
    expect(detectUsageLimit(RECORDED.codexSpend, NOW)).toMatchObject({
      kind: "spend",
      reason: "spend limit, ask your admin to raise it",
    });
    expect(detectUsageLimit(RECORDED.codexQuota, NOW)).toMatchObject({ kind: "credits" });
    expect(detectUsageLimit(RECORDED.codexRate, NOW)).toMatchObject({ kind: "rate" });
  });

  it("OpenRouter's credits, budget (with its ISO reset) and rate limit", () => {
    expect(detectUsageLimit(RECORDED.openrouterCredits, NOW)).toMatchObject({ kind: "credits" });
    expect(detectUsageLimit(RECORDED.openrouterBudget, NOW)).toMatchObject({
      kind: "spend",
      reason: "spend limit, ask your admin to raise it",
      resetsAt: "2026-11-09T00:00:00.000Z",
    });
    expect(detectUsageLimit(RECORDED.openrouterRate, NOW)).toMatchObject({ kind: "rate" });
  });

  it("Kimi's quota and rate limit", () => {
    expect(detectUsageLimit(RECORDED.kimiQuota, NOW)).toMatchObject({ kind: "credits" });
    expect(detectUsageLimit(RECORDED.kimiRate, NOW)).toMatchObject({ kind: "rate" });
  });

  it("a busy service, a sign-out or an ordinary failure is not a limit", () => {
    for (const t of [
      "Kimi turn produced no events: Error code: 429 - {'error': {'message': 'The engine is currently overloaded, please try again later', 'type': 'engine_overloaded_error'}}",
      'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      "Failed to authenticate. API Error: 401 OAuth access token is invalid",
      "Tests failed: 3 of 120",
      "",
      null,
    ]) {
      expect(detectUsageLimit(t, NOW)).toBeNull();
    }
  });

  it("a time already past today means tomorrow", () => {
    // 11:50 PM New York: "resets 12:10am" is ten minutes later, the next day.
    const t = parseResetTime(
      "resets 12:10am (America/New_York)",
      new Date("2026-11-06T04:50:00.000Z"),
    );
    expect(t).toBe("2026-11-06T05:10:00.000Z");
  });
});
