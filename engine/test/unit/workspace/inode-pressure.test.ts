import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canDispatch,
  checkInodePressure,
  createInodePressureState,
} from "../../../src/workspace/inode-pressure.js";

/**
 * Watchdog for FRG-1547: `/data` inode exhaustion. We can't easily force the
 * host filesystem into an inode-pressure state during tests, so these cover
 * (1) the memoization / transition semantics, (2) the swallowed-error path,
 * and (3) that a normal filesystem produces zero warns.
 */
describe("checkInodePressure", () => {
  let root: string;
  let logger: {
    warn: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "forge-inode-pressure-test-"));
    logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("does not warn when free ratios stay above the configured threshold", async () => {
    const state = createInodePressureState();

    // Use warnRatio=0 so the assertion is independent of the host filesystem.
    // The real default (0.15) is exercised by the transition/warn-payload tests.
    await checkInodePressure(
      { workspaceRoot: root, warnRatio: 0, logger: logger as unknown as Logger },
      state,
    );

    expect(logger.warn).not.toHaveBeenCalled();
    expect(state.pressed).toBe(false);
  });

  it("warns exactly once on a transition into pressure, and clears once on recovery", async () => {
    const state = createInodePressureState();
    // Use warnRatio=2 to force pressure regardless of actual free ratio,
    // then swap to 0 to clear it.
    const pressCfg = {
      workspaceRoot: root,
      warnRatio: 2, // impossible-to-satisfy — always pressed
      logger: logger as unknown as Logger,
    };
    const clearCfg = { ...pressCfg, warnRatio: 0 };

    // First tick: transition into pressure → 1 warn.
    await checkInodePressure(pressCfg, state);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(state.pressed).toBe(true);
    // Second tick still pressed: NO additional warn (memoization).
    await checkInodePressure(pressCfg, state);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    // Third tick pressure clears: 1 info (clear).
    await checkInodePressure(clearCfg, state);
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(state.pressed).toBe(false);
    // Fourth tick still clear: NO additional info.
    await checkInodePressure(clearCfg, state);
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  it("swallows statfs failures (bad path) and emits at most a debug log", async () => {
    const state = createInodePressureState();

    await expect(
      checkInodePressure(
        {
          workspaceRoot: "/nonexistent/path/that/cannot/exist",
          logger: logger as unknown as Logger,
        },
        state,
      ),
    ).resolves.not.toThrow();

    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
    // debug MAY be called (implementation detail); assert it does not spam
    // warn/info in the failure branch.
    expect(state.pressed).toBe(false);
  });

  it("survives a missing logger (no logger configured)", async () => {
    const state = createInodePressureState();

    await expect(
      checkInodePressure({ workspaceRoot: root, logger: undefined }, state),
    ).resolves.not.toThrow();
    await expect(
      checkInodePressure({ workspaceRoot: root, warnRatio: 2, logger: undefined }, state),
    ).resolves.not.toThrow();

    // The warn-ratio=2 call above forced pressed=true even though there was
    // no logger to receive the warning; the state machine must still track.
    expect(state.pressed).toBe(true);
  });

  it("warn payload carries the workspace path and free ratios", async () => {
    const state = createInodePressureState();

    await checkInodePressure(
      {
        workspaceRoot: root,
        warnRatio: 2,
        logger: logger as unknown as Logger,
      },
      state,
    );

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [payload, message] = logger.warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(payload.path).toBe(root);
    expect(payload).toHaveProperty("freeInodePct");
    expect(payload).toHaveProperty("freeBytePct");
    expect(message).toContain("inode/byte pressure");
    expect(message).toContain("FRG-1547");
  });
});

describe("canDispatch", () => {
  let root: string;
  let logger: {
    warn: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "forge-can-dispatch-test-"));
    logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("allows dispatch when free ratios are above the dispatch threshold", async () => {
    const state = createInodePressureState();

    const allowed = await canDispatch(
      { workspaceRoot: root, dispatchRatio: 0, logger: logger as unknown as Logger },
      state,
    );

    expect(allowed).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(state.dispatchBlocked).toBe(false);
  });

  it("blocks dispatch when free ratios are below the dispatch threshold", async () => {
    const state = createInodePressureState();

    const allowed = await canDispatch(
      { workspaceRoot: root, dispatchRatio: 2, logger: logger as unknown as Logger },
      state,
    );

    expect(allowed).toBe(false);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [payload, message] = logger.warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(payload.path).toBe(root);
    expect(payload).toHaveProperty("freeInodePct");
    expect(payload).toHaveProperty("freeBytePct");
    expect(message).toContain("dispatch blocked");
    expect(message).toContain("FRG-1886");
    expect(state.dispatchBlocked).toBe(true);
  });

  it("warns once per blocked episode using the shared state", async () => {
    const state = createInodePressureState();
    const cfg = {
      workspaceRoot: root,
      dispatchRatio: 2,
      logger: logger as unknown as Logger,
    };

    await canDispatch(cfg, state);
    await canDispatch(cfg, state);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(state.dispatchBlocked).toBe(true);
  });

  it("resets the dispatch-block latch when pressure clears", async () => {
    const state = createInodePressureState();
    const blockedCfg = {
      workspaceRoot: root,
      dispatchRatio: 2,
      logger: logger as unknown as Logger,
    };
    const clearCfg = { ...blockedCfg, dispatchRatio: 0 };

    await canDispatch(blockedCfg, state);
    expect(state.dispatchBlocked).toBe(true);

    await canDispatch(clearCfg, state);
    expect(state.dispatchBlocked).toBe(false);

    // The next blocked episode should warn again.
    await canDispatch(blockedCfg, state);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it("fail-open: allows dispatch when statfs throws", async () => {
    const state = createInodePressureState();

    const allowed = await canDispatch(
      {
        workspaceRoot: "/nonexistent/path/that/cannot/exist",
        logger: logger as unknown as Logger,
      },
      state,
    );

    expect(allowed).toBe(true);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const message = logger.warn.mock.calls[0][1] as string;
    expect(message).toContain("dispatch gate statfs failed");
  });
});
