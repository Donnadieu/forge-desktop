/**
 * Codex `turn/start` sandbox policies (app-server protocol, codex-cli 0.117).
 *
 * A single-tenant build worker keeps `dangerFullAccess`: it owns its box. A
 * session over a tenant repo on the shared factory box (the quality gate) runs
 * its commands under `workspaceWrite` instead (FRG-4315). Codex builds that
 * sandbox with bubblewrap: writes are confined to the writable roots (codex
 * keeps `.git` and `.codex` in them read-only), and only the readable roots
 * plus the platform defaults (/usr, /etc, /bin, /lib) are mounted, so `/data`
 * and the rest of the host are not. Commands get their own PID namespace, so
 * the factory processes' `/proc/<pid>/environ` is out of sight. The host /tmp
 * is swapped for a private one per command: every gate tree and HOME lives
 * there, and a private /tmp keeps one command's scratch files from the next
 * (each session has its own uid, FRG-5158, but a session runs many commands).
 * That private /tmp also hides an implicit cwd under /tmp,
 * so the repo is passed as an explicit root.
 */

import { isAbsolute } from "node:path";
import type { CodexSandboxPolicy } from "./codex-protocol.js";

export type { CodexSandboxPolicy };

export const DANGER_FULL_ACCESS: CodexSandboxPolicy = Object.freeze({ type: "dangerFullAccess" });

/**
 * The policy for a session over a tenant `repo` (its cwd): it may write the
 * repo and its session `home`, and read those plus `readableRoots` (e.g. the
 * baked Playwright browsers). Codex rejects a relative root, so one (such as
 * Playwright's `0`) is left out. Network stays on for the provider API,
 * browser QA against localhost and package installs.
 */
export function tenantRepoSandboxPolicy(
  repo: string,
  home: string,
  readableRoots: string[],
): CodexSandboxPolicy {
  return {
    type: "workspaceWrite",
    writableRoots: [repo, home],
    networkAccess: true,
    excludeSlashTmp: true,
    excludeTmpdirEnvVar: true,
    readOnlyAccess: {
      type: "restricted",
      includePlatformDefaults: true,
      readableRoots: [repo, home, ...readableRoots.filter((root) => isAbsolute(root))],
    },
  };
}
