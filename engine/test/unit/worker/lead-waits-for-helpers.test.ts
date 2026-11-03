/**
 * The lead waits for its helpers (plan section 5). A fake Claude Code process
 * plays the lead: it sends a helper in the background, ends its turn at once,
 * and the helper keeps working. The helper writes a file only if it is still
 * alive when its work is done, so the file proves it was not killed mid-work.
 */
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "../../../src/agent/claude.js";
import type { AgentEvent } from "../../../src/agent/types.js";
import { MemoryTracker } from "../../../src/tracker/memory.js";
import type { NormalizedIssue } from "../../../src/tracker/types.js";
import { runWorker } from "../../../src/worker/runner.js";
import { WorkspaceManager } from "../../../src/workspace/manager.js";

const issue: NormalizedIssue = {
  id: "issue-helpers",
  identifier: "FD-1",
  title: "Lead with helpers",
  description: "",
  state: "Todo",
  priority: 1,
  labels: [],
  blockedBy: [],
  createdAt: "2026-11-03T00:00:00Z",
  updatedAt: "2026-11-03T00:00:00Z",
};

/** A stand-in for `claude -p --input-format stream-json --output-format stream-json`. */
function fakeClaude(dir: string, helperMs: number): string {
  const path = join(dir, "fake-claude.mjs");
  writeFileSync(
    path,
    `#!${process.execPath}
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const rl = createInterface({ input: process.stdin });
let first = true;
rl.on("line", () => {
  if (!first) return;
  first = false;
  out({ type: "system", subtype: "init" });
  out({ type: "assistant", message: { content: [{ type: "tool_use", name: "Agent", input: { run_in_background: true } }] } });
  out({ type: "system", subtype: "task_started", task_id: "t1", description: "Write the tests" });
  out({ type: "assistant", message: { content: [{ type: "text", text: "Helper sent; ending my turn." }] } });
  out({ type: "result", subtype: "success", is_error: false, result: "waiting" });
  setTimeout(() => {
    writeFileSync("helper-finished", "the helper finished its work");
    out({ type: "system", subtype: "task_notification", task_id: "t1", status: "completed", summary: "tests written" });
    out({ type: "assistant", message: { content: [{ type: "text", text: "The helper reported back." }] } });
    out({ type: "result", subtype: "success", is_error: false, result: "done" });
  }, ${helperMs});
});
setInterval(() => {}, 1000);
`,
  );
  chmodSync(path, 0o755);
  return path;
}

describe("the lead waits for its helpers", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  async function run(opts: { helperMs: number; helperWaitMs: number }) {
    const dir = mkdtempSync(join(tmpdir(), "forge-helpers-"));
    dirs.push(dir);
    const agent = new ClaudeCodeAdapter({ command: fakeClaude(dir, opts.helperMs), model: "test" });
    const tracker = new MemoryTracker([issue]);
    const workspace = new WorkspaceManager({ root: join(dir, "cards"), hooks: {} });
    const events: AgentEvent[] = [];
    const result = await runWorker(
      issue,
      {
        maxTurns: 1,
        // Both far shorter than the helper's work: the old runner would have
        // stopped the lead (and its helper) long before the helper finished.
        readTimeoutMs: 300,
        turnTimeoutMs: 400,
        helperWaitMs: opts.helperWaitMs,
        promptTemplate: "Work on {{ issue.identifier }}",
        trackerConfig: {
          kind: "memory",
          project_slug: "test",
          active_states: ["Todo"],
          terminal_states: ["Done"],
        },
      },
      agent,
      tracker,
      workspace,
      { onEvent: (_id, e) => events.push(e) },
    );
    const card = join(dir, "cards", "FD-1");
    return { result, events, tracker, helperFinished: existsSync(join(card, "helper-finished")) };
  }

  it("keeps the session alive until the helper reports back, so nothing is killed mid-work", async () => {
    const { result, events, helperFinished } = await run({ helperMs: 1200, helperWaitMs: 10_000 });
    expect(helperFinished).toBe(true);
    expect(result.success).toBe(true);
    const kinds = events.map((e) => (e.type === "helper" ? `helper:${e.status}` : e.type));
    expect(kinds).toContain("helper:started");
    expect(kinds).toContain("waiting_for_helpers");
    expect(kinds.indexOf("helper:finished")).toBeGreaterThan(kinds.indexOf("waiting_for_helpers"));
    expect(kinds.filter((k) => k === "done")).toHaveLength(1);
    expect(kinds.at(-1)).toBe("done");
  });

  it("stops at the wait limit and leaves a plain note on the card", async () => {
    const { result, tracker, helperFinished } = await run({ helperMs: 5000, helperWaitMs: 500 });
    expect(result.success).toBe(false);
    expect(helperFinished).toBe(false);
    const notes = await tracker.fetchIssueComments(issue.id);
    expect(notes.map((n) => n.body).join("\n")).toMatch(
      /waited 0 minutes for 1 helper that had not finished: "Write the tests"/,
    );
  });
});
