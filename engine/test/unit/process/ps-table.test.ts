import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  forgetPsTable,
  macBootId,
  parseBootTime,
  parsePidsOfUid,
  parsePidsWithEnv,
  parsePsTable,
  psPidsWithEnv,
  psTable,
} from "../../../src/process/ps-table.js";

describe("macOS process table: parsing ps", () => {
  it("reads pid, parent, group, state and start time", () => {
    const rows = parsePsTable(
      "    1     0     1 Ss   Wed Oct 21 22:39:24 2026\n" +
        "  812     1   812 S+   Tue Nov  3 09:01:02 2026\n" +
        "garbage line\n",
    );
    expect(rows.size).toBe(2);
    expect(rows.get(812)).toEqual({
      pid: 812,
      ppid: 1,
      pgid: 812,
      stat: "S+",
      started: "Tue Nov  3 09:01:02 2026",
    });
  });

  it("finds a marker only as a whole environment word", () => {
    const out =
      "  10 node agent.js FORGE_AGENT_TREE=abc HOME=/Users/x\n" +
      "  11 node other.js FORGE_AGENT_TREE=abcd\n" +
      "  12 grep FORGE_AGENT_TREE=abc-not\n";
    expect(parsePidsWithEnv(out, "FORGE_AGENT_TREE", "abc")).toEqual([10]);
  });

  it("matches real, effective or saved uid and skips zombies", () => {
    const out = " 5 501 0 0 S\n 6 0 501 0 R\n 7 0 0 501 Z\n 8 0 0 0 S\n";
    expect(parsePidsOfUid(out, 501)).toEqual([5, 6]);
  });

  it("reads the boot time from sysctl", () => {
    expect(parseBootTime("{ sec = 1792636764, usec = 461176 } Wed Oct 21 22:39:24 2026")).toBe(
      "1792636764",
    );
    expect(parseBootTime("nonsense")).toBeUndefined();
  });
});

// The live half runs on a Mac where `ps` may be used (CI's macOS runner, a developer's Mac).
const psWorks = process.platform === "darwin" && psTable().size > 0;

describe.skipIf(!psWorks)("macOS process table: live", () => {
  it("sees this process, its parent and a child carrying a marker", async () => {
    const marker = `test-${process.pid}-${Date.now()}`;
    const child = spawn("sleep", ["5"], {
      env: { ...process.env, FORGE_PS_TABLE_TEST: marker },
      stdio: "ignore",
    });
    try {
      await new Promise((r) => setTimeout(r, 200));
      forgetPsTable();
      const me = psTable().get(process.pid);
      expect(me?.ppid).toBe(process.ppid);
      expect(me?.started).not.toBe("");
      expect(psPidsWithEnv("FORGE_PS_TABLE_TEST", marker)).toEqual([child.pid]);
      expect(macBootId()).toMatch(/^\d+$/);
    } finally {
      child.kill();
    }
  });
});
