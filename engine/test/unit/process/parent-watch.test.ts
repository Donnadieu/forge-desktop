import { afterEach, describe, expect, it, vi } from "vitest";
import { appPidFromEnv, watchParent } from "../../../src/process/parent-watch.js";

describe("watchParent", () => {
  afterEach(() => vi.useRealTimers());

  it("calls back once when the parent stops being the app", () => {
    vi.useFakeTimers();
    let parent = 4242;
    const gone = vi.fn();
    watchParent(gone, { appPid: 4242, intervalMs: 1000, parentPid: () => parent });
    vi.advanceTimersByTime(3000);
    expect(gone).not.toHaveBeenCalled();
    parent = 1; // the app died: launchd took the engine over
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(5000);
    expect(gone).toHaveBeenCalledTimes(1);
  });

  it("watches nothing without an app pid", () => {
    vi.useFakeTimers();
    const gone = vi.fn();
    watchParent(gone, { appPid: undefined, intervalMs: 1000, parentPid: () => 1 });
    vi.advanceTimersByTime(5000);
    // appPid undefined falls back to FORGE_APP_PID, unset under the tests.
    expect(gone).not.toHaveBeenCalled();
  });

  it("stops watching when asked", () => {
    vi.useFakeTimers();
    const gone = vi.fn();
    const stop = watchParent(gone, { appPid: 4242, intervalMs: 1000, parentPid: () => 1 });
    stop();
    vi.advanceTimersByTime(5000);
    expect(gone).not.toHaveBeenCalled();
  });
});

describe("appPidFromEnv", () => {
  it("reads a pid and ignores anything else", () => {
    expect(appPidFromEnv({ FORGE_APP_PID: "812" })).toBe(812);
    expect(appPidFromEnv({})).toBeUndefined();
    expect(appPidFromEnv({ FORGE_APP_PID: "1" })).toBeUndefined();
    expect(appPidFromEnv({ FORGE_APP_PID: "abc" })).toBeUndefined();
  });
});
