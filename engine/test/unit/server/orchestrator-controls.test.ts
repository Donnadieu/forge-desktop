import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import type { Orchestrator } from "../../../src/orchestrator/orchestrator.js";
import { type LocalApi, startLocalApi } from "../../../src/server/local-api.js";
import { createOrchestratorControls } from "../../../src/server/orchestrator-controls.js";
import type { IntendedState } from "../../../src/server/types.js";

const TOKEN = "t".repeat(48);

/** An orchestrator whose drain lasts until the test lets the running agent finish. */
function slowOrchestrator() {
  let finish: () => void = () => {};
  const drained = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const fake = {
    start: () => {},
    stop: () => drained,
    getPollHealth: () => ({
      lastPollAtMs: null,
      lastPollError: null,
      consecutiveEmptyPolls: 0,
      running: 1,
      retrying: 0,
    }),
  };
  return { orchestrator: fake as unknown as Orchestrator, finish };
}

function controlsWith(orchestrator: Orchestrator, intents: IntendedState[]) {
  return createOrchestratorControls({
    orchestrator,
    workflowPath: "WORKFLOW.md",
    config: {
      tracker: { kind: "linear", project_slug: "p", active_states: ["Todo"] },
      agent: { max_concurrent_agents: 1 },
    },
    logger: pino({ level: "silent" }),
    intendedState: {
      read: async () => "running",
      write: async (desired) => {
        intents.push(desired);
      },
    },
  });
}

const settle = () => new Promise((r) => setTimeout(r, 10));

describe("Stop while an agent is still working", () => {
  let api: LocalApi | undefined;
  afterEach(async () => {
    await api?.close();
    api = undefined;
  });

  it("answers at once and drains in the background", async () => {
    const { orchestrator, finish } = slowOrchestrator();
    const intents: IntendedState[] = [];
    const controls = controlsWith(orchestrator, intents);
    await controls.startOrchestrator(null);

    // Never settles while the agent runs: the old stop waited for the drain here.
    expect(await controls.stopOrchestrator(null)).toEqual({ stopped: true });
    expect(controls.getStatus().state).toBe("stopping");
    expect(intents).toEqual(["running", "stopped"]);

    // Start is refused until the agent has finished, and a second Stop is a no-op.
    expect(await controls.startOrchestrator(null)).toEqual({ started: false, reason: "stopping" });
    expect(await controls.stopOrchestrator(null)).toEqual({ stopped: false });

    finish();
    await settle();
    expect(controls.getStatus().state).toBe("stopped");
    expect(controls.getStatus().startedAt).toBeNull();
    expect(await controls.startOrchestrator(null)).toEqual({ started: true });
  });

  it("POST /api/v1/stop replies in well under the app's 15 s timeout", async () => {
    const { orchestrator, finish } = slowOrchestrator();
    const controls = controlsWith(orchestrator, []);
    await controls.startOrchestrator(null);
    api = await startLocalApi({
      token: TOKEN,
      getState: () => ({ status: controls.getStatus().state }),
      start: () => controls.startOrchestrator(null),
      stop: () => controls.stopOrchestrator(null),
      refresh: () => {},
    });
    const base = `http://127.0.0.1:${api.port}`;
    const auth = { authorization: `Bearer ${TOKEN}` };

    const res = await fetch(`${base}/api/v1/stop`, {
      method: "POST",
      headers: auth,
      signal: AbortSignal.timeout(2_000),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stopped: true });
    const during = await (await fetch(`${base}/api/v1/state`, { headers: auth })).json();
    expect(during).toEqual({ status: "stopping" });

    finish();
    await settle();
    const after = await (await fetch(`${base}/api/v1/state`, { headers: auth })).json();
    expect(after).toEqual({ status: "stopped" });
  });

  it("a failed drain still ends in stopped", async () => {
    const fake = {
      start: () => {},
      stop: () => Promise.reject(new Error("boom")),
      getPollHealth: () => ({
        lastPollAtMs: null,
        lastPollError: null,
        consecutiveEmptyPolls: 0,
        running: 0,
        retrying: 0,
      }),
    } as unknown as Orchestrator;
    const controls = controlsWith(fake, []);
    await controls.startOrchestrator(null);
    expect(await controls.stopOrchestrator(null)).toEqual({ stopped: true });
    await settle();
    expect(controls.getStatus().state).toBe("stopped");
  });
});
