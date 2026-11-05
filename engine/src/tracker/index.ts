export { type BasecampAdapterOptions, BasecampTracker } from "./basecamp.js";
export { LinearTracker } from "./linear.js";
export { MemoryTracker } from "./memory.js";
export type {
  NormalizedIssue,
  TrackerAdapter,
  TrackerConfig,
} from "./types.js";

import { type BasecampAdapterOptions, BasecampTracker } from "./basecamp.js";
import { LinearTracker } from "./linear.js";
import { MemoryTracker } from "./memory.js";
import type { TrackerAdapter } from "./types.js";

export function createTracker(
  kind: string,
  opts?: { endpoint?: string; apiKey?: string } & Partial<
    Omit<BasecampAdapterOptions, "endpoint" | "apiKey">
  >,
): TrackerAdapter {
  switch (kind) {
    case "linear":
      return new LinearTracker(opts?.endpoint, opts?.apiKey);
    case "basecamp":
      return new BasecampTracker(opts?.endpoint, opts?.apiKey, {
        accountId: opts?.accountId,
        projectId: opts?.projectId,
        identityId: opts?.identityId,
        columns: opts?.columns,
        cardTableId: opts?.cardTableId,
        tokenProvider: opts?.tokenProvider,
      });
    case "memory":
      return new MemoryTracker();
    default:
      throw new Error(`Unknown tracker kind: ${kind}`);
  }
}
