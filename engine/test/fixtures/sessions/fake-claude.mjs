#!/usr/bin/env node
// A stand-in for `claude -p --input-format stream-json --output-format stream-json`, for the sessions tests.
// Each user message starts a turn that "works" for 400 ms (one tool call), then answers with the last message
// it read ("printenv NAME" answers with that variable). A message that arrives during a turn steers it (the answer names it). An interrupt control request
// ends the turn at once with error_during_execution. The process stays alive between turns.
import { createInterface } from "node:readline";

const sessionArg = process.argv.indexOf("--session-id");
const resumeArg = process.argv.indexOf("--resume");
const sessionId = process.argv[(sessionArg > 0 ? sessionArg : resumeArg) + 1] ?? "fake";
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
// Like Claude Code 2.1.32x: with --replay-user-messages each message is echoed back when the agent reads it.
const replay = process.argv.includes("--replay-user-messages");
let turn = null;
let n = 0;

function finish(text, error) {
  if (!turn) return;
  clearTimeout(turn.timer);
  if (!error) {
    const id = `msg_${++n}`;
    out({ type: "stream_event", event: { type: "message_start", message: { id } } });
    out({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text" } } });
    out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text.slice(0, 4) } } });
    out({ type: "assistant", message: { id, content: [{ type: "text", text }], usage: { input_tokens: 100, output_tokens: 5 } } });
  }
  out({ type: "result", subtype: error ? "error_during_execution" : "success", is_error: Boolean(error), result: error ? "" : text, session_id: sessionId });
  turn = null;
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.type === "control_request" && m.request.subtype === "interrupt") {
    out({ type: "control_response", response: { subtype: "success", request_id: m.request_id } });
    finish("", true);
    return;
  }
  if (m.type !== "user") return;
  const text = m.message.content;
  if (turn) {
    turn.steer = text;
    return;
  }
  out({ type: "system", subtype: "init", session_id: sessionId, model: "fake" });
  if (replay) out({ type: "user", isReplay: true, message: { role: "user", content: text } });
  const toolId = `toolu_${++n}`;
  out({ type: "assistant", message: { id: `msg_${n}`, content: [{ type: "tool_use", id: toolId, name: "Bash", input: { command: "sleep 0.4", description: "Wait a moment" } }] } });
  turn = { text, steer: null };
  turn.timer = setTimeout(() => {
    out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: toolId, content: "ok" }] } });
    if (replay && turn.steer) out({ type: "user", isReplay: true, message: { role: "user", content: turn.steer } });
    // "printenv NAME" answers with that variable, so tests can see what the agent was given.
    const asked = /^printenv (\w+)$/.exec(turn.text);
    const answer = asked ? `env ${asked[1]}=${process.env[asked[1]] ?? ""}` : `answer: ${turn.text}`;
    finish(turn.steer ? `steered: ${turn.steer}` : answer, false);
  }, 400);
});
