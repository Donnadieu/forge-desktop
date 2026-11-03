import { expect } from "vitest";
import { AGENT_TREE_ENV, AGENT_WORKSPACE_ENV } from "../../src/process/procfs.js";

/** The env markers `spawnProcessGroup` adds to every agent session child (FRG-4527). */
export function agentTreeMarkers(workspacePath: string) {
  return {
    [AGENT_TREE_ENV]: expect.any(String),
    [AGENT_WORKSPACE_ENV]: workspacePath,
  };
}
