import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { thinkingDisplayArgs } from "../../../src/process/thinking-display.js";
import { claudeArgs } from "../../../src/sessions/claude-chat.js";

/** A stand-in `claude` that refuses the first option it doesn't know, like Claude Code's option parser. */
function fakeClaude(knows: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "thinking-"));
  const file = join(dir, "claude");
  const list = knows.map((k) => `"${k}"`).join(" ");
  writeFileSync(
    file,
    `#!/bin/sh
for a in "$@"; do
  case "$a" in
    --*) ok=0; for k in -p ${list}; do [ "$a" = "$k" ] && ok=1; done
         if [ $ok = 0 ]; then echo "error: unknown option '$a'" >&2; exit 1; fi;;
  esac
done
exit 0
`,
  );
  chmodSync(file, 0o755);
  return file;
}

describe("thinking the person can open", () => {
  it("asks Claude Code for its thinking's words when it knows how", async () => {
    expect(await thinkingDisplayArgs(fakeClaude(["--thinking-display"]), 3000, {})).toEqual([
      "--thinking-display",
      "summarized",
    ]);
  });

  it("leaves the flag off a Claude Code too old to know it", async () => {
    expect(await thinkingDisplayArgs(fakeClaude([]), 3000, {})).toEqual([]);
  });

  it("leaves it off when the command can't be run", async () => {
    expect(await thinkingDisplayArgs("/nonexistent/claude", 3000, {})).toEqual([]);
  });

  it("leaves it off, without waiting long, when the command never answers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "thinking-"));
    const file = join(dir, "claude");
    writeFileSync(file, "#!/bin/sh\nsleep 30\n");
    chmodSync(file, 0o755);
    const t = Date.now();
    expect(await thinkingDisplayArgs(file, 300, {})).toEqual([]);
    expect(Date.now() - t).toBeLessThan(2000);
  });

  it("is skipped when the engine is told to (its own tests)", async () => {
    expect(
      await thinkingDisplayArgs(fakeClaude(["--thinking-display"]), 3000, {
        FORGE_THINKING_DISPLAY: "off",
      }),
    ).toEqual([]);
  });

  it("a chat passes it on when Claude Code knows it", () => {
    const a = claudeArgs({
      model: "opus[1m]",
      effort: "high",
      sessionId: "s1",
      resume: false,
      permissionMode: "bypassPermissions",
      thinkingDisplay: ["--thinking-display", "summarized"],
    });
    expect(a.join(" ")).toContain("--thinking-display summarized");
  });
});
