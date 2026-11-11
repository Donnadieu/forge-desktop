import { spawn } from "node:child_process";

/**
 * Claude Code keeps only a signature of the model's thinking unless it's asked for the words, so a "Thought" row had
 * nothing to open. `--thinking-display summarized` asks for a short summary of each stretch of thinking; it lands in
 * the stream and in the transcript a card's session follows. The flag is new and hidden from `--help`, and an older
 * Claude Code refuses to start with it, so ask once per command whether it knows it: Claude Code's option parser
 * stops before any request at the first option it doesn't know and names it, so an unknown option put after it says
 * which of the two it tripped on. A command that doesn't answer within a few seconds (a stand-in) gets no flag.
 */
const known = new Map<string, Promise<string[]>>();
const PROBE = "--x-option-probe";
const FLAG = ["--thinking-display", "summarized"];

export function thinkingDisplayArgs(command: string, timeoutMs = 3000): Promise<string[]> {
  let answer = known.get(command);
  if (!answer) {
    answer = probe(command, timeoutMs);
    known.set(command, answer);
  }
  return answer;
}

function probe(command: string, timeoutMs: number): Promise<string[]> {
  return new Promise((resolve) => {
    let said = "";
    let done = false;
    const finish = (args: string[]) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(args);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, ["-p", ...FLAG, PROBE], { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve([]);
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish([]);
    }, timeoutMs);
    child.stdout?.on("data", (c: Buffer) => {
      said += c.toString();
    });
    child.stderr?.on("data", (c: Buffer) => {
      said += c.toString();
    });
    child.on("error", () => finish([]));
    child.on("close", () => finish(said.includes(PROBE) && !said.includes(FLAG[0]) ? FLAG : []));
  });
}
