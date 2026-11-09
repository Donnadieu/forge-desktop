import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attachImages, claudeContent } from "../../../src/sessions/attachments.js";

// A 1x1 PNG.
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe("pictures in a message", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "forge-att-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("keeps each picture as a file and one line per picture in the message", () => {
    const text = attachImages(home, "chat-1", "What's wrong here?", [
      { mediaType: "image/png", data: PNG },
      { mediaType: "application/pdf", data: PNG },
    ]);
    const lines = text.split("\n");
    expect(lines[0]).toBe("What's wrong here?");
    expect(lines).toHaveLength(2);
    const path = /^\[image: (.+)\]$/.exec(lines[1] ?? "")?.[1] ?? "";
    expect(path.startsWith(join(home, "attachments", "chat-1"))).toBe(true);
    expect(existsSync(path)).toBe(true);
  });

  it("turns those lines into image blocks for Claude Code, and leaves plain text alone", () => {
    const text = attachImages(home, "chat-1", "Look", [{ mediaType: "image/png", data: PNG }]);
    const content = claudeContent(text) as Record<string, unknown>[];
    expect(content[0]).toMatchObject({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: PNG },
    });
    expect(content[1]).toEqual({ type: "text", text: "Look" });
    expect(claudeContent("just words")).toBe("just words");
    expect(claudeContent("[image: /no/such/file.png]")).toBe("[image: /no/such/file.png]");
  });
});
