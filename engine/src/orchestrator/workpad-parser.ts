export interface ChecklistItem {
  text: string;
  completed: boolean;
}

export interface WorkpadData {
  planItems: ChecklistItem[];
  acceptanceCriteria: ChecklistItem[];
  validationSteps: ChecklistItem[];
  confusions: string[];
  notes: string[];
}

/** `## Workpad`; cards started before 0.2.23 carry `## Forge Workpad`, which still counts. */
const WORKPAD_HEADER = /^##\s+(?:Forge\s+)?Workpad\b/m;

const SECTION_HEADERS = [
  "### Plan",
  "### Acceptance Criteria",
  "### Validation",
  "### Notes",
  "### Confusions",
] as const;

/**
 * Find the workpad comment body from a list of comments.
 * Returns the comment body or null if not found.
 */
export function findWorkpadComment(comments: Array<{ body: string }>): string | null {
  for (const comment of comments) {
    if (WORKPAD_HEADER.test(comment.body)) {
      return comment.body;
    }
  }
  return null;
}

/**
 * Parse a workpad comment into structured data.
 * Returns null if the comment doesn't contain a valid workpad.
 */
export function parseWorkpad(commentBody: string): WorkpadData | null {
  if (!WORKPAD_HEADER.test(commentBody)) return null;

  const sections = splitSections(commentBody);

  return {
    planItems: parseChecklist(sections.get("### Plan") ?? ""),
    acceptanceCriteria: parseChecklist(sections.get("### Acceptance Criteria") ?? ""),
    validationSteps: parseChecklist(sections.get("### Validation") ?? ""),
    confusions: parseBulletList(sections.get("### Confusions") ?? ""),
    notes: parseBulletList(sections.get("### Notes") ?? ""),
  };
}

/**
 * Split workpad content into named sections based on ### headers.
 */
function splitSections(body: string): Map<string, string> {
  const result = new Map<string, string>();
  const lines = body.split("\n");

  let currentSection: string | null = null;
  let currentContent: string[] = [];

  for (const line of lines) {
    const trimmed = line.trimEnd();
    const matchedHeader = SECTION_HEADERS.find((h) => trimmed === h);

    if (matchedHeader) {
      if (currentSection) {
        result.set(currentSection, currentContent.join("\n").trim());
      }
      currentSection = matchedHeader;
      currentContent = [];
    } else if (currentSection) {
      currentContent.push(line);
    }
  }

  if (currentSection) {
    result.set(currentSection, currentContent.join("\n").trim());
  }

  return result;
}

/**
 * Parse markdown checklist items (- [ ] and - [x]) into structured items.
 * Handles nested items by flattening them.
 */
function parseChecklist(content: string): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  const lines = content.split("\n");

  for (const line of lines) {
    const match = line.match(/^\s*-\s+\[([ xX])\]\s+(.*)/);
    if (match) {
      items.push({
        completed: match[1].toLowerCase() === "x",
        text: match[2].trim(),
      });
    }
  }

  return items;
}

/**
 * Parse simple bullet list items (- text) into strings.
 * Skips empty items and checklist items.
 */
function parseBulletList(content: string): string[] {
  const items: string[] = [];
  const lines = content.split("\n");

  for (const line of lines) {
    // Skip checklist items
    if (/^\s*-\s+\[[ xX]\]/.test(line)) continue;

    const match = line.match(/^\s*-\s+(.*)/);
    if (match) {
      const text = match[1].trim();
      if (text) items.push(text);
    }
  }

  return items;
}
