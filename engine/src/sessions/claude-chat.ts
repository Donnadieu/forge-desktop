/**
 * One chat with Claude Code: a long-lived `claude -p` process speaking JSON lines both ways.
 *
 * - The first message starts the process (`--session-id`); later ones are written to its stdin. A message
 *   written while a turn runs steers that same turn (Claude Code reads it at its next step).
 * - Stop sends `{subtype: "interrupt"}`: the turn ends at once and the process stays for the next message.
 * - The model changes live (`set_model`); plan mode and "ask before changes" change the permission mode live.
 * - `--permission-prompt-tool stdio` sends every permission question, the agent's multiple-choice questions
 *   (AskUserQuestion) and its plans (ExitPlanMode) back here as `can_use_tool` requests.
 * - After a restart the chat resumes with `--resume <id>` in the same folder.
 *
 * Checked live with Claude Code 2.1.319 (Nov 9, 2026). New in Forge Desktop.
 */

import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { hasExited, spawnProcessGroup, terminateChild } from "../process/process-tree.js";
import { claudeContent } from "./attachments.js";

export interface ClaudeChatOptions {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  model: string;
  effort: string;
  /** Claude Code's session id: new chats start with it, old ones resume it. */
  sessionId: string;
  resume: boolean;
  permissionMode: PermissionMode;
  /** `--thinking-display summarized` when this Claude Code knows it (agent/thinking-display.ts). */
  thinkingDisplay?: string[];
  onLine: (raw: Record<string, unknown>) => void;
  onExit: (code: number | null, stderr: string) => void;
}

export type PermissionMode = "bypassPermissions" | "default" | "plan";

export function claudeArgs(
  o: Pick<
    ClaudeChatOptions,
    "model" | "effort" | "sessionId" | "resume" | "permissionMode" | "thinkingDisplay"
  >,
): string[] {
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-prompt-tool",
    "stdio",
    "--permission-mode",
    o.permissionMode,
    "--model",
    o.model,
  ];
  if (o.effort && o.effort !== "off") args.push("--effort", o.effort);
  args.push(...(o.thinkingDisplay ?? []));
  args.push(o.resume ? "--resume" : "--session-id", o.sessionId);
  return args;
}

export class ClaudeChat {
  private child: ChildProcess | null = null;
  private stderr: Buffer[] = [];
  private requestSeq = 0;

  constructor(private readonly o: ClaudeChatOptions) {}

  get running(): boolean {
    return this.child !== null && !hasExited(this.child);
  }

  start(): void {
    if (this.running) return;
    this.stderr = [];
    const child = spawnProcessGroup(this.o.command, claudeArgs(this.o), {
      cwd: this.o.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: this.o.env,
    });
    child.on("error", () => {});
    child.stderr?.on("data", (c: Buffer) => {
      this.stderr.push(c);
      if (this.stderr.length > 64) this.stderr.shift();
    });
    if (!child.stdout) throw new Error("the agent has no output stream");
    const rl = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        this.o.onLine(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // not JSON (a startup notice): ignore
      }
    });
    child.on("exit", (code) => {
      if (this.child === child) this.child = null;
      this.o.onExit(code, Buffer.concat(this.stderr).toString().trim().slice(-2000));
    });
    this.child = child;
  }

  private write(obj: unknown): void {
    this.child?.stdin?.write(`${JSON.stringify(obj)}\n`);
  }

  /** Sends a message: starts a turn when idle, steers the running turn otherwise. */
  send(text: string): void {
    this.start();
    this.write({ type: "user", message: { role: "user", content: claudeContent(text) } });
  }

  private control(request: Record<string, unknown>): void {
    this.requestSeq += 1;
    this.write({ type: "control_request", request_id: `forge-${this.requestSeq}`, request });
  }

  interrupt(): void {
    if (this.running) this.control({ subtype: "interrupt" });
  }

  setModel(model: string): void {
    this.o.model = model;
    if (this.running) this.control({ subtype: "set_model", model });
  }

  setPermissionMode(mode: PermissionMode): void {
    this.o.permissionMode = mode;
    if (this.running) this.control({ subtype: "set_permission_mode", mode });
  }

  /** Effort only applies at start: the next turn resumes with the new value. */
  setEffort(effort: string): void {
    this.o.effort = effort;
    this.o.resume = true;
    if (this.running) void this.close();
  }

  /** Answers a `can_use_tool` request: allow (with the input to use) or deny with a reason. */
  answer(requestId: string, allow: boolean, input: unknown, message?: string): void {
    this.write({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response: allow
          ? { behavior: "allow", updatedInput: input }
          : { behavior: "deny", message: message ?? "The person said no." },
      },
    });
  }

  /** From now on the chat resumes its session instead of starting a new one. */
  markStarted(): void {
    this.o.resume = true;
  }

  async close(): Promise<void> {
    const c = this.child;
    this.child = null;
    if (c && !hasExited(c)) await terminateChild(c);
  }
}
