import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { describe, expect, it, onTestFinished } from "vitest";
import { createLogger, issueLogger, sessionLogger } from "../../../src/observability/logger.js";

describe("createLogger", () => {
  it("creates a logger with default settings", () => {
    const logger = createLogger({ pretty: false });
    expect(logger).toBeDefined();
    expect(logger.level).toBe("info");
  });

  it("creates a logger with custom level", () => {
    const logger = createLogger({ level: "debug", pretty: false });
    expect(logger.level).toBe("debug");
  });

  it("creates child loggers with context", () => {
    const logger = createLogger({ pretty: false });
    const child = issueLogger(logger, "issue-1", "MT-42");
    expect(child).toBeDefined();

    const session = sessionLogger(logger, "session-1", "/tmp/ws");
    expect(session).toBeDefined();
  });
});

// Regression: a forge-pipeline MCP server speaks JSONRPC over stdout via
// StdioServerTransport. The shared createLogger helper must NEVER write to stdout
// (fd 1), or its JSON log lines corrupt the protocol stream and the client rejects
// them with "Failed to parse JSONRPC message" (pydantic ValidationError for
// JSONRPCMessage). All log output must go to stderr (fd 2). See the
// repo-creator-required-env wallets/auth warn that originally tripped this.
describe("createLogger never pollutes stdout (MCP stdio safety)", () => {
  it("non-pretty branch writes to stderr (fd 2), not stdout (fd 1)", () => {
    // The branch every MCP-loaded module uses: createLogger({ pretty: false }).
    // Assert the underlying pino destination targets fd 2 — deterministic, in-process.
    const logger = createLogger({ pretty: false });
    const stream = logger[pino.symbols.streamSym] as { fd?: number };
    expect(stream.fd).toBe(2);
  });

  // Faithful end-to-end check of real OS-level fd routing for BOTH branches: spawn a
  // child that builds the logger and emits a warn, capturing its stdout/stderr
  // separately. The non-pretty path is synchronous; the pretty path flushes its
  // pino-pretty worker on exit.
  const loggerPath = fileURLToPath(
    new URL("../../../src/observability/logger.ts", import.meta.url),
  );
  const MARKER = "STDIO_GUARD_MARKER wallets/auth write path";

  function emitWarn(opts: string): { stdout: string; stderr: string } {
    // Run from a temp .mts file (not --eval): the pino-pretty transport spawns a
    // worker thread, and --input-type=module would propagate to and break it.
    const dir = mkdtempSync(join(tmpdir(), "logger-stdio-test-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const scriptPath = join(dir, "probe.mts");
    writeFileSync(
      scriptPath,
      `import { createLogger } from ${JSON.stringify(loggerPath)};\n` +
        `const log = createLogger(${opts});\n` +
        `log.warn(${JSON.stringify(MARKER)});\n`,
    );
    const res = spawnSync(process.execPath, ["--import", "tsx", scriptPath], { encoding: "utf8" });
    expect(res.status).toBe(0);
    return { stdout: res.stdout, stderr: res.stderr };
  }

  it("pretty: false — nothing on stdout, message on stderr", () => {
    const { stdout, stderr } = emitWarn(`{ level: "warn", pretty: false }`);
    expect(stdout).not.toContain(MARKER);
    expect(stdout.trim()).toBe("");
    expect(stderr).toContain(MARKER);
  });

  it("pretty: true — nothing on stdout, message on stderr", () => {
    const { stdout, stderr } = emitWarn(`{ level: "warn" }`);
    expect(stdout).not.toContain(MARKER);
    expect(stdout.trim()).toBe("");
    expect(stderr).toContain(MARKER);
  });
});

// Secret-safety (FRG-2075, BYOK T11): createLogger installs a pino `redact`
// config so key-shaped fields never ship their plaintext value to stdout/file.
// Spawn a child that builds the logger and logs an object carrying secrets in
// every shape we redact, then assert the emitted line censors each one — for
// both the structured (pretty: false) and pretty branches.
describe("createLogger redacts key-shaped fields", () => {
  const loggerPath = fileURLToPath(
    new URL("../../../src/observability/logger.ts", import.meta.url),
  );
  const SECRET = "sk-should-never-appear-in-logs";

  function emitObject(opts: string): { stdout: string; stderr: string } {
    const dir = mkdtempSync(join(tmpdir(), "logger-redact-test-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const scriptPath = join(dir, "probe.mts");
    const payload = {
      apiKey: SECRET,
      api_key: SECRET,
      token: SECRET,
      authToken: SECRET,
      secret: SECRET,
      password: SECRET,
      ANTHROPIC_API_KEY: SECRET,
      OPENAI_API_KEY: SECRET,
      GH_TOKEN: SECRET,
      FORGE_FLY_API_TOKEN: SECRET,
      nested: { apiKey: SECRET, token: SECRET },
      // A non-secret field must survive unredacted.
      model: "kimi-k2.7-code",
    };
    writeFileSync(
      scriptPath,
      `import { createLogger } from ${JSON.stringify(loggerPath)};\n` +
        `const log = createLogger(${opts});\n` +
        `log.warn(${JSON.stringify(payload)}, "redact-probe");\n`,
    );
    const res = spawnSync(process.execPath, ["--import", "tsx", scriptPath], { encoding: "utf8" });
    expect(res.status).toBe(0);
    return { stdout: res.stdout, stderr: res.stderr };
  }

  it("pretty: false (structured JSON) — every secret shape is censored", () => {
    const { stdout, stderr } = emitObject(`{ level: "warn", pretty: false }`);
    const out = stdout + stderr;
    expect(out).not.toContain(SECRET);
    expect(out).toContain("[REDACTED]");
    // Non-secret identifier survives.
    expect(out).toContain("kimi-k2.7-code");
  });

  it("pretty: true — every secret shape is censored", () => {
    const { stdout, stderr } = emitObject(`{ level: "warn" }`);
    const out = stdout + stderr;
    expect(out).not.toContain(SECRET);
    expect(out).toContain("[REDACTED]");
    expect(out).toContain("kimi-k2.7-code");
  });
});

// Secret-safety (FRG-2075, BYOK T11): a persisted log FILE is the highest-value
// leak target (it survives the process), and both file-transport branches
// (fileOnly and file+console) receive the `redact` + value-scrub config. Spawn a
// child that builds a file logger, log a secret payload AND a secret-shaped msg
// string, then read the file back and assert the secret never lands on disk.
describe("createLogger redacts secrets written to a log file", () => {
  const loggerPath = fileURLToPath(
    new URL("../../../src/observability/logger.ts", import.meta.url),
  );
  const SECRET = "sk-ant-file-should-never-appear-000000";

  function emitToFile(fileOnly: boolean): string {
    const dir = mkdtempSync(join(tmpdir(), "logger-file-redact-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const logFile = join(dir, "worker.log");
    const scriptPath = join(dir, "probe.mts");
    const payload = { apiKey: SECRET, nested: { deeper: { detail: `leaked ${SECRET}` } } };
    writeFileSync(
      scriptPath,
      `import { createLogger } from ${JSON.stringify(loggerPath)};\n` +
        `const log = createLogger({ level: "info", logFile: ${JSON.stringify(logFile)}, fileOnly: ${fileOnly} });\n` +
        `log.warn(${JSON.stringify(payload)}, "token=${SECRET}");\n` +
        // Give the pino/file worker thread a tick to flush before the process exits.
        `await new Promise((r) => setTimeout(r, 250));\n`,
    );
    const res = spawnSync(process.execPath, ["--import", "tsx", scriptPath], { encoding: "utf8" });
    expect(res.status).toBe(0);
    return readFileSync(logFile, "utf8");
  }

  it("fileOnly branch — secret payload and msg string are censored on disk", () => {
    const contents = emitToFile(true);
    expect(contents).not.toContain(SECRET);
    expect(contents).toContain("[REDACTED]");
  });

  it("file+console branch — secret payload and msg string are censored on disk", () => {
    const contents = emitToFile(false);
    expect(contents).not.toContain(SECRET);
    expect(contents).toContain("[REDACTED]");
  });
});

// The name-based `redact.paths` layer must censor on KEY alone — use an opaque
// value that no shape pattern or env value matches, so the value-scrub hook
// cannot be what hides it. Two levels down is outside pino's `*.` reach by
// design; pin that limit so it is a documented choice, not a surprise.
describe("createLogger name-based redaction (opaque values)", () => {
  it("censors key-shaped fields top-level and one level deep", () => {
    const res = spawnProbe(
      `const log = createLogger({ pretty: false });\n` +
        `log.info({ apiKey: "opaque-plain-value", ANTHROPIC_API_KEY: "opaque-plain-value", ` +
        `nested: { token: "opaque-plain-value" }, headers: { authorization: "opaque-plain-value" }, ` +
        `a: { b: { apiKey: "opaque-deep-value" } } }, "names");\n`,
    );
    const line = JSON.parse(res.stderr.trim().split("\n").pop() ?? "{}");
    expect(line.apiKey).toBe("[REDACTED]");
    expect(line.ANTHROPIC_API_KEY).toBe("[REDACTED]");
    expect(line.nested.token).toBe("[REDACTED]");
    expect(line.headers.authorization).toBe("[REDACTED]");
    expect(line.a.b.apiKey).toBe("opaque-deep-value");
  });
});

// The value-scrub layer: Errors (the most common way a secret reaches a log),
// printf args, live env values with no known shape, child bindings, and
// objects (cycles, URL/Request, DOMException) that must never make a log throw.
describe("createLogger value-based redaction", () => {
  const SECRET = "sk-ant-api03-errorLeakProbe000000000000";
  const OPAQUE = "opaque-live-env-value-123";

  it("scrubs Error message/stack, printf args, and live env values; tolerates cycles", () => {
    const res = spawnProbe(
      `const log = createLogger({ pretty: false });\n` +
        `log.error({ err: new Error("boom ${SECRET}") }, "in obj");\n` +
        `log.error(new Error("bare ${SECRET}"));\n` +
        `log.info("printf %s", "${SECRET}");\n` +
        `log.info({ note: "dump ${OPAQUE}" }, "env value");\n` +
        `const cyc = { name: "cyc" }; cyc.self = cyc; log.info(cyc, "cycle");\n` +
        `log.info("after cycle");\n` +
        `log.child({ binding: "bound ${SECRET}" }).info("child");\n` +
        `log.child({ a: 1 }).child({ grand: "g ${SECRET}" }).info("grandchild");\n` +
        `log.info({ url: new URL("https://h/x"), req: new Request("https://h/y") }, "exotic");\n` +
        `log.info("after exotic");\n` +
        `log.warn({ err: new DOMException("aborted ${SECRET}", "AbortError") }, "dom");\n` +
        `log.info({ url: new URL("https://x:${SECRET}@h/p"), at: new Date(0), status: 500 }, "url");\n`,
      { OPENROUTER_API_KEY: OPAQUE },
    );
    expect(res.status).toBe(0);
    expect(res.stderr).not.toContain(SECRET);
    expect(res.stderr).not.toContain(OPAQUE);
    const lines = res.stderr
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines[0].err.type).toBe("Error");
    expect(lines[0].err.message).toBe("boom [REDACTED]");
    expect(lines[1].err.message).toBe("bare [REDACTED]");
    expect(lines[1].msg).toBe("bare [REDACTED]");
    expect(lines[4].self).toBe("[Circular]");
    expect(lines[5].msg).toBe("after cycle");
    // Child bindings never pass through logMethod — the wrapped child() scrubs them.
    expect(lines[6].binding).toBe("bound [REDACTED]");
    expect(lines[7].grand).toBe("g [REDACTED]");
    // The grandchild keeps its parent's bindings (created off the child, not the root).
    expect(lines[7].a).toBe(1);
    // pino's redact walk throws on URL/Request private fields — the call must
    // still log (objects dropped), and later calls keep working.
    expect(lines[8].msg).toBe("exotic");
    expect(lines[9].msg).toBe("after exotic");
    // DOMException's brand-checked getters must not make the log call throw.
    expect(lines[10].err.message).toBe("aborted [REDACTED]");
    expect(lines[10].msg).toBe("dom");
    // A lone URL/Date serializes via toJSON (scrubbed) — it and its siblings survive.
    expect(lines[11].url).toBe("https://[REDACTED]@h/p");
    expect(lines[11].at).toBe("1970-01-01T00:00:00.000Z");
    expect(lines[11].status).toBe(500);
    expect(lines[11].redactionFailed).toBeUndefined();
  });
});

// FRG-3938: a token_crypto rotation key value is scrubbed both from free text
// (value scrub in logMethod) and as a named field (pino redact.paths).
describe("createLogger redacts FORGE_TOKEN_ENCRYPTION_KEY_<n> rotation keys", () => {
  it("scrubs a _2 rotation key value from a log line and a named field", () => {
    const KEY = "q4T0r9Vb2wZ1mN8xK3pL6sD5fH7jA0cE2gR4tY9uIo8=";
    const res = spawnProbe(
      `const log = createLogger({ pretty: false });\n` +
        `log.info("loaded rotation key ${KEY}");\n` +
        `log.info({ FORGE_TOKEN_ENCRYPTION_KEY_2: "opaque-field-value" }, "field");\n`,
      { FORGE_TOKEN_ENCRYPTION_KEY_2: KEY },
    );
    expect(res.status).toBe(0);
    expect(res.stderr).not.toContain(KEY);
    const lines = res.stderr
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines[0].msg).toBe("loaded rotation key [REDACTED]");
    expect(lines[1].FORGE_TOKEN_ENCRYPTION_KEY_2).toBe("[REDACTED]");
  });
});

function spawnProbe(
  body: string,
  env: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  const loggerPath = fileURLToPath(
    new URL("../../../src/observability/logger.ts", import.meta.url),
  );
  const dir = mkdtempSync(join(tmpdir(), "logger-value-redact-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const scriptPath = join(dir, "probe.mts");
  writeFileSync(scriptPath, `import { createLogger } from ${JSON.stringify(loggerPath)};\n${body}`);
  const res = spawnSync(process.execPath, ["--import", "tsx", scriptPath], {
    encoding: "utf8",
    // NODE_NO_WARNINGS: newer Node prints a loader deprecation warning to
    // stderr for `--import tsx`, which would precede the JSON log lines.
    env: { ...process.env, NODE_NO_WARNINGS: "1", ...env },
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}
