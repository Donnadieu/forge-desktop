/**
 * The sessions host's entry: the same bundled engine, started with FORGE_ENGINE_MODE=sessions. One per Mac.
 * Its folder (FORGE_ENGINE_HOME) holds `sessions.sqlite`, Forge's clones (`repos/`) and the sessions' folders
 * (`folders/`). Prints `FORGE_ENGINE_READY {"port":N}` like the board engine; SIGTERM stops every chat's agent, and so
 * does the app going away (`FORGE_APP_PID`, process/parent-watch.ts), and dev servers left in `folders/` stop with it. A
 * leftover host whose app is gone is replaced first (process/engine-takeover.ts).
 *
 * New in Forge Desktop.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../observability/logger.js";
import { replaceLeftoverEngines } from "../process/engine-takeover.js";
import { watchParent } from "../process/parent-watch.js";
import { stopLeftoverServers } from "../workspace/leftover-sweep.js";
import { startSessionsApi } from "./api.js";
import { SessionsHost } from "./host.js";
import { SessionStore } from "./store.js";

export async function runSessionsHost(): Promise<void> {
  const token = process.env.FORGE_API_TOKEN ?? "";
  if (token.length < 32) throw new Error("FORGE_API_TOKEN is missing or too short");
  const home =
    process.env.FORGE_ENGINE_HOME ?? join(homedir(), "Library/Application Support/Forge/sessions");
  const logFile = process.env.FORGE_LOG_FILE ?? join(homedir(), "Library/Logs/Forge/sessions.log");
  const logger = createLogger({ level: "info", logFile, fileOnly: true });
  // One sessions host per folder: a leftover whose app is gone stops before this one opens the store.
  await replaceLeftoverEngines(home, { logger });
  const store = new SessionStore(join(home, "sessions.sqlite"));
  let broadcast: (f: Record<string, unknown>) => void = () => {};
  const host = new SessionsHost(store, {
    home,
    command: process.env.FORGE_CLAUDE_COMMAND || "claude",
    notify: (f) => broadcast(f),
  });
  const api = await startSessionsApi({ token, host: () => host, store, logger });
  broadcast = api.broadcast;
  await host.chats.recover();

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "Forge sessions host stopping");
    host.cards.close();
    await host.chats.closeAll();
    // Dev servers the chats' agents left running detached in Forge's session folders go with the host.
    await stopLeftoverServers(join(home, "folders"), { logger });
    await api.close();
    store.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  watchParent(() => void shutdown("app gone"));
  process.stdout.write(`FORGE_ENGINE_READY ${JSON.stringify({ port: api.port })}\n`);
  logger.info({ port: api.port, home }, "Forge sessions host ready");
}
