export { LinearTracker } from "./linear.js";
export { MemoryTracker } from "./memory.js";
export type {
  NormalizedIssue,
  TrackerAdapter,
  TrackerConfig,
} from "./types.js";

import { LinearTracker } from "./linear.js";
import { MemoryTracker } from "./memory.js";
import type { TrackerAdapter } from "./types.js";

export function createTracker(
  kind: string,
  opts?: { endpoint?: string; apiKey?: string },
): TrackerAdapter {
  switch (kind) {
    case "linear":
      return new LinearTracker(opts?.endpoint, opts?.apiKey);
    case "memory":
      return new MemoryTracker();
    default:
      throw new Error(`Unknown tracker kind: ${kind}`);
  }
}
