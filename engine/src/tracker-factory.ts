/**
 * Builds the tracker the workflow file names. Each kind reads its own secret
 * from the environment and (for Basecamp) its project wiring from the workflow
 * file; there is no fallback between kinds, so a Basecamp board never picks up
 * a stray Linear key.
 *
 * Lives at the entry layer (like `index.ts`) because it reads both the
 * workflow config and the environment, which `tracker/` may not import.
 *
 * Adapted from Forge's `src/tracker-factory.ts`: Forge Desktop's Basecamp
 * token comes from the app (`FORGE_BASECAMP_TOKEN_COMMAND`, a JSON array:
 * the app's own binary and `--basecamp-token`), which keeps the sign-in in the
 * Keychain and renews it there.
 */
import type { WorkflowConfig } from "./config/schema.js";
import type { Logger } from "./observability/logger.js";
import {
  type BasecampTokenProvider,
  createCommandTokenFn,
  RefreshingBasecampTokenProvider,
  StaticBasecampTokenProvider,
} from "./tracker/basecamp-token-provider.js";
import { createTracker } from "./tracker/index.js";
import type { TrackerAdapter } from "./tracker/types.js";

/** The command that prints a fresh Basecamp token, or null when it isn't set or isn't a JSON array. */
export function tokenCommand(raw: string | undefined): string[] | null {
  if (!raw?.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((p) => typeof p === "string")) {
      return parsed as string[];
    }
  } catch {
    // not JSON
  }
  return null;
}

function basecampTokenProvider(env: NodeJS.ProcessEnv, logger?: Logger): BasecampTokenProvider {
  const command = tokenCommand(env.FORGE_BASECAMP_TOKEN_COMMAND);
  if (command) {
    return new RefreshingBasecampTokenProvider({
      refresh: createCommandTokenFn({ command }),
      onRefreshed: (s) =>
        logger?.info(
          { expiresAt: new Date(s.expiresAtMs).toISOString() },
          "basecamp token renewed",
        ),
      onRefreshFailed: (message) => logger?.warn({ message }, "basecamp token not renewed"),
    });
  }
  return new StaticBasecampTokenProvider(env.FORGE_BASECAMP_API_KEY ?? "");
}

export function createTrackerFromConfig(
  config: WorkflowConfig,
  env: NodeJS.ProcessEnv,
  logger?: Logger,
): TrackerAdapter {
  if (config.tracker.kind === "basecamp") {
    return createTracker("basecamp", {
      tokenProvider: basecampTokenProvider(env, logger),
      endpoint: config.tracker.endpoint ?? env.FORGE_BASECAMP_ENDPOINT,
      accountId: config.tracker.account_id,
      // Basecamp has no slug: project_slug is the project (bucket) id.
      projectId: config.tracker.project_slug,
      identityId: config.tracker.identity_id,
      columns: config.tracker.columns,
      cardTableId: config.tracker.card_table_id,
    });
  }
  return createTracker(config.tracker.kind, {
    endpoint: config.tracker.endpoint,
    apiKey: config.tracker.api_key ?? env.LINEAR_API_KEY,
  });
}
