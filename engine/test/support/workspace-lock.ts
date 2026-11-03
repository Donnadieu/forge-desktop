import { vi } from "vitest";

/** A `WorkspaceManager.acquireLock` stub that always grants the lock. */
export function grantedWorkspaceLock() {
  const lock = {
    recordAgentPid: vi.fn().mockResolvedValue(undefined),
    release: vi.fn().mockResolvedValue(undefined),
  };
  return { lock, acquireLock: vi.fn().mockResolvedValue({ acquired: true, lock }) };
}
