/**
 * The engine stops when the app that started it is gone. The app stops its
 * engines when it quits, but a crash, a force quit or an update that kills
 * it leaves them running with launchd as their parent: on one Mac seven old
 * engines (and the chats they held) ran for up to a week after their app,
 * about 2.5 GB. The app passes its pid in `FORGE_APP_PID`; when the engine's
 * parent is no longer that pid, it shuts down the same way as on SIGTERM.
 * Without `FORGE_APP_PID` (a developer running the engine by hand) nothing
 * is watched.
 *
 * New in Forge Desktop.
 */

/** How often the parent is checked. */
export const PARENT_WATCH_INTERVAL_MS = 5000;

export interface ParentWatchOptions {
  /** The app's pid (default `FORGE_APP_PID`). */
  appPid?: number;
  intervalMs?: number;
  /** This process's parent pid now (tests). */
  parentPid?: () => number;
}

/** The pid in `FORGE_APP_PID`, or undefined when unset or not a pid. */
export function appPidFromEnv(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const pid = Number(env.FORGE_APP_PID);
  return Number.isInteger(pid) && pid > 1 ? pid : undefined;
}

/**
 * Calls `onGone` once when the parent stops being the app. Returns a stop
 * function. The timer never keeps the process alive.
 */
export function watchParent(onGone: () => void, options: ParentWatchOptions = {}): () => void {
  const appPid = options.appPid ?? appPidFromEnv();
  if (appPid === undefined) return () => {};
  const parentPid = options.parentPid ?? (() => process.ppid);
  const timer = setInterval(() => {
    if (parentPid() === appPid) return;
    clearInterval(timer);
    onGone();
  }, options.intervalMs ?? PARENT_WATCH_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
