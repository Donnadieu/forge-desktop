import { describe, expect, it } from "vitest";
import { htmlToMarkdown } from "../../../src/tracker/rich-text.js";

describe("htmlToMarkdown", () => {
  it("turns a Basecamp workpad into the Markdown the window reads", () => {
    const html =
      "<div><h2>Forge Workpad</h2><p><strong>Plan</strong> for <code>BC-1</code></p>" +
      "<ul><li>[x] read the code</li><li>[ ] write the test</li><li>ship it</li></ul>" +
      '<p>PR: <a href="https://github.com/o/r/pull/7">https://github.com/o/r/pull/7</a></p>' +
      "<p>a &amp; b</p></div>";
    expect(htmlToMarkdown(html)).toBe(
      [
        "## Forge Workpad",
        "**Plan** for `BC-1`",
        "",
        "- [x] read the code",
        "- [ ] write the test",
        "- ship it",
        "PR: https://github.com/o/r/pull/7",
        "a & b",
      ].join("\n"),
    );
  });

  it("leaves Markdown alone", () => {
    expect(htmlToMarkdown("## Forge Workpad\n- [ ] x")).toBe("## Forge Workpad\n- [ ] x");
  });
});
