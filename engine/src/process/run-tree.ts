import type { SpawnOptions } from "node:child_process";
import { spawnProcessGroup, terminateChild } from "./process-tree.js";

/** How long to keep reading an exited leader's output before closing it. */
const EXIT_GRACE_MS = 2000;

/** How a {@link runProcessTree} run ended, with everything it wrote. */
export interface TreeRun {
  /** `exit`: the leader exited on its own; `timeout` / `abort`: it was killed. */
  outcome: "exit" | "timeout" | "abort";
  /** The leader's exit code; `null` when killed or ended by a signal. */
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface RunTreeOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  /** Written to stdin, which is then closed; stdin stays open when omitted. */
  input?: string;
}

/**
 * Run a one-off command as a process tree (FRG-5427) and collect its output.
 * Settles only once the whole tree is gone — on timeout or abort it is
 * killed, and on a normal exit whatever the command left running is swept —
 * so nothing it started outlives the call. Rejects only on a spawn or stdin
 * failure (e.g. `ENOENT`), after the same cleanup.
 */
export function runProcessTree(
  command: string,
  args: readonly string[],
  options: Omit<SpawnOptions, "stdio" | "detached">,
  { timeoutMs, signal, input }: RunTreeOptions,
): Promise<TreeRun> {
  if (signal?.aborted) {
    return Promise.resolve({ outcome: "abort", code: null, stdout: "", stderr: "" });
  }
  return new Promise((resolve, reject) => {
    const child = spawnProcessGroup(
      command,
      args,
      { ...options, stdio: ["pipe", "pipe", "pipe"] },
      { killOnExit: true },
    );
    let stdout = "";
    let stderr = "";
    let killedBy: "timeout" | "abort" | undefined;
    let finished = false;

    const finish = (result: number | null | Error): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      void terminateChild(child).then(() => {
        if (result instanceof Error) reject(result);
        else resolve({ outcome: killedBy ?? "exit", code: result, stdout, stderr });
      });
    };
    const kill = (why: "timeout" | "abort"): void => {
      if (finished) return;
      killedBy = why;
      finish(null);
    };
    const timer = setTimeout(() => kill("timeout"), timeoutMs);
    const onAbort = (): void => kill("abort");
    signal?.addEventListener("abort", onAbort, { once: true });

    child.on("exit", () => {
      if (finished) return; // killed: settles once the tree is gone
      // A process the command left running may hold its stdout open, and
      // `close` waits for that: sweep the tree, and stop reading shortly after.
      void terminateChild(child);
      setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, EXIT_GRACE_MS).unref();
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", finish);
    child.on("close", (code: number | null) => finish(code));
    if (input === undefined) return;
    child.stdin?.on("error", (err: NodeJS.ErrnoException) => {
      // EPIPE: the command exited before reading its input; `close` reports why.
      if (err.code !== "EPIPE") finish(err);
    });
    child.stdin?.end(input);
  });
}
