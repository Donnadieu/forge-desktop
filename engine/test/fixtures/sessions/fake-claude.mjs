#!/usr/bin/env node
// A stand-in for `claude -p --input-format stream-json --output-format stream-json`, for the sessions tests.
// Each user message starts a turn that "works" for 400 ms (one tool call), then answers with the last message
// it read ("printenv NAME" answers with that variable). A message that arrives during a turn steers it (the answer names it). An interrupt control request
// ends the turn at once with error_during_execution. The process stays alive between turns.
//
// Questions, like Claude Code 2.1.322 (checked live, Nov 12): "ask me" asks two multiple-choice questions
// (AskUserQuestion, sent as a `can_use_tool` control request) and waits for the answer. Messages that come meanwhile
// wait in its queue, unread and not echoed, until the question is answered; then each is read in order (echoed) and
// the answer names them (after 300 ms more of work). An interrupt cancels the question (`control_cancel_request`) and ends the turn; a message
// still queued then starts a turn of its own. "ask me and hang" never answers an interrupt while its question waits
// (a stuck agent). "think slowly" works 3 s without a tool call and reads nothing meanwhile. "work slowly" runs one
// tool call that takes 1.5 s.
import { createInterface } from "node:readline";

const sessionArg = process.argv.indexOf("--session-id");
const resumeArg = process.argv.indexOf("--resume");
const sessionId = process.argv[(sessionArg > 0 ? sessionArg : resumeArg) + 1] ?? "fake";
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
// Like Claude Code 2.1.32x: with --replay-user-messages each message is echoed back when the agent reads it.
const replay = process.argv.includes("--replay-user-messages");
const echo = (text) => {
  if (replay) out({ type: "user", isReplay: true, message: { role: "user", content: text } });
};
let turn = null;
let n = 0;

const QUESTIONS = [
  { question: "Which colour?", header: "Colour", multiSelect: false, options: [{ label: "Red" }, { label: "Blue" }] },
  { question: "Which size?", header: "Size", multiSelect: false, options: [{ label: "Small" }, { label: "Large" }] },
];

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
  const queued = turn.queue ?? [];
  turn = null;
  // Claude Code runs a message still in its queue as a turn of its own once the turn ends.
  if (queued.length > 0) begin(queued.shift(), queued);
}

function ask(text, queue) {
  const toolId = `toolu_${++n}`;
  const requestId = `req_${n}`;
  out({ type: "assistant", message: { id: `msg_${n}`, content: [{ type: "tool_use", id: toolId, name: "AskUserQuestion", input: { questions: QUESTIONS } }] } });
  out({ type: "control_request", request_id: requestId, request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input: { questions: QUESTIONS }, tool_use_id: toolId } });
  turn = { text, steer: null, asking: { requestId, toolId }, hang: /hang/.test(text), queue };
}

function answered(m) {
  const r = m.response?.response ?? {};
  const { toolId } = turn.asking;
  turn.asking = null;
  let said;
  if (r.behavior === "allow") {
    const answers = r.updatedInput?.answers ?? {};
    said = QUESTIONS.map((q) => `${q.question}=${answers[q.question] ?? "?"}`).join("; ");
    out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: toolId, content: `The user answered: ${said}` }] } });
  } else {
    said = `no (${r.message ?? ""})`;
    out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: toolId, content: said, is_error: true }] } });
  }
  // The agent works on for a moment: the messages that waited, and any that come meanwhile, are read then, in order.
  turn.answered = true;
  turn.timer = setTimeout(() => {
    const read = turn.queue.splice(0);
    for (const t of read) echo(t);
    finish(`answered: ${said}${read.length ? `; steered: ${read.join(", ")}` : ""}`, false);
  }, 300);
}

function begin(text, carried = []) {
  out({ type: "system", subtype: "init", session_id: sessionId, model: "fake" });
  echo(text);
  if (/^ask me/.test(text)) return ask(text, carried);
  if (/^think slowly/.test(text)) {
    turn = { text, steer: null, deaf: true, queue: carried };
    turn.timer = setTimeout(() => finish(`thought: ${text}`, false), 3000);
    return;
  }
  const toolId = `toolu_${++n}`;
  out({ type: "assistant", message: { id: `msg_${n}`, content: [{ type: "tool_use", id: toolId, name: "Bash", input: { command: "sleep 0.4", description: "Wait a moment" } }] } });
  turn = { text, steer: null, queue: carried };
  turn.timer = setTimeout(
    () => {
      out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: toolId, content: "ok" }] } });
      if (turn.steer) echo(turn.steer);
      // "printenv NAME" answers with that variable, so tests can see what the agent was given.
      const asked = /^printenv (\w+)$/.exec(turn.text);
      const answer = asked ? `env ${asked[1]}=${process.env[asked[1]] ?? ""}` : `answer: ${turn.text}`;
      finish(turn.steer ? `steered: ${turn.steer}` : answer, false);
    },
    /^work slowly/.test(text) ? 1500 : 400,
  );
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.type === "control_request" && m.request.subtype === "interrupt") {
    if (turn?.asking && turn.hang) return; // stuck: the interrupt is never answered
    if (turn?.asking) out({ type: "control_cancel_request", request_id: turn.asking.requestId });
    out({ type: "control_response", response: { subtype: "success", request_id: m.request_id } });
    finish("", true);
    return;
  }
  if (m.type === "control_response" && turn?.asking && m.response?.request_id === turn.asking.requestId) {
    answered(m);
    return;
  }
  if (m.type !== "user") return;
  const text = m.message.content;
  if (turn?.asking || turn?.deaf || turn?.answered) {
    turn.queue.push(text);
    return;
  }
  if (turn) {
    turn.steer = text;
    return;
  }
  begin(text);
});
