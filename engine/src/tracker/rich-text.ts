/**
 * Basecamp keeps comments as HTML. The app's workpad view reads a small
 * Markdown subset (headings, `- ` bullets, `- [ ]` checklists, inline
 * `**bold**` and `code`), so an HTML comment is turned into that subset.
 * Text that isn't HTML comes back unchanged (Linear comments are Markdown).
 *
 * New in Forge Desktop.
 */
const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&nbsp;": " ",
};

export function looksLikeHtml(text: string): boolean {
  return /^\s*<[a-z][^>]*>/i.test(text);
}

export function htmlToMarkdown(text: string): string {
  if (!looksLikeHtml(text)) return text;
  const md = text
    .replace(/\r?\n/g, " ")
    .replace(/<h1[^>]*>/gi, "\n# ")
    .replace(/<h2[^>]*>/gi, "\n## ")
    .replace(/<h[3-6][^>]*>/gi, "\n### ")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|h[1-6]|ul|ol|blockquote|pre)>/gi, "\n")
    .replace(/<(?:strong|b)>(.*?)<\/(?:strong|b)>/gi, "**$1**")
    .replace(/<code>(.*?)<\/code>/gi, "`$1`")
    .replace(/<a [^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi, (_m, href: string, label: string) =>
      label.trim() && label.trim() !== href ? `[${label}](${href})` : href,
    )
    .replace(/<[^>]*>/g, "")
    .replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (e) => ENTITIES[e] ?? e);
  return md
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .map((l) => l.replace(/^- \[(x|X| )\]\s*/, (_m, x: string) => `- [${x === " " ? " " : "x"}] `))
    .filter((l, i, all) => l !== "" || (i > 0 && all[i - 1] !== ""))
    .join("\n")
    .trim();
}
