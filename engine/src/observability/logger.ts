import pino from "pino";
import { SECRET_VALUE_ENV_NAMES } from "./secret-env-names.js";
import { REDACTION, redactSecretsDeep, redactSecretsFromString } from "./secret-redact.js";

export type Logger = pino.Logger;

export interface LoggerOptions {
  level?: string;
  logFile?: string;
  pretty?: boolean;
  /** When true, write only to logFile (no stdout). Requires logFile. */
  fileOnly?: boolean;
}

// Secret-safety (FRG-2075, BYOK T11). Two layers:
//
// 1. `redact.paths` censors key-shaped fields by NAME — a stray
//    `logger.info({ apiKey }, ...)` or a logged `process.env` never ships its
//    value. pino paths are matched case-sensitively, so cover camelCase
//    (`apiKey`) and snake_case (`api_key`); the bare form censors the top level
//    and the `*.` form one level deep. Non-secret identifiers (`token`-suffixed
//    IDs excluded on purpose) stay readable.
// 2. `hooks.logMethod` (see below) scrubs by VALUE — every string leaf, at any
//    depth (Errors included), and the message string itself — through the shared `secret-redact`
//    module. This closes the two gaps `redact.paths` can't: secrets echoed into
//    a `msg` string (`logger.info(\`token=${key}\`)`) and secret-shaped values
//    under an unlisted or deeply-nested key.
const SECRET_KEY_FIELDS: readonly string[] = [
  "apiKey",
  "api_key",
  "token",
  "authToken",
  "auth_token",
  "accessToken",
  "refreshToken",
  "sessionToken",
  "bearerToken",
  "secret",
  "clientSecret",
  "webhookSecret",
  "serviceRoleKey",
  "privateKey",
  "credentials",
  "password",
  "authorization",
  "Authorization",
  "cookie",
];
const REDACT_PATHS: readonly string[] = [
  ...SECRET_KEY_FIELDS,
  ...SECRET_KEY_FIELDS.map((k) => `*.${k}`),
  ...SECRET_VALUE_ENV_NAMES,
  ...SECRET_VALUE_ENV_NAMES.map((n) => `*.${n}`),
  // Logged request/response shapes carry auth one level below `headers`.
  "*.headers.authorization",
  "*.headers.Authorization",
  "*.headers.cookie",
];

// Value-based scrub applied to every log call before pino serializes it. Runs
// in the main thread (works with worker-thread transports) and complements the
// name-based `redact.paths` above. Strings are scrubbed directly; plain
// objects, arrays, and Errors are deep-scrubbed leaf-by-leaf (see
// `redactSecretsDeep`). Redaction must never make a log call throw: on an
// unexpected failure, keep only the scrubbed string args and drop the objects
// rather than emit them unscrubbed.
function scrubLogArg(arg: unknown): unknown {
  if (typeof arg === "string") return redactSecretsFromString(arg);
  if (arg && typeof arg === "object") return redactSecretsDeep(arg);
  return arg;
}

const loggerHooks: pino.LoggerOptions["hooks"] = {
  logMethod(args, method) {
    let scrubbed: unknown[];
    try {
      scrubbed = args.map(scrubLogArg);
    } catch {
      scrubbed = args.map((arg) =>
        arg && typeof arg === "object" ? { redactionFailed: true } : scrubLogArg(arg),
      );
    }
    try {
      return method.apply(this, scrubbed as Parameters<typeof method>);
    } catch {
      // pino's name-based `redact.paths` walk can throw on exotic objects (a
      // `URL`/`Request` with private fields); logging must still not throw.
      const fallback = scrubbed.map((arg) =>
        arg && typeof arg === "object" ? { redactionFailed: true } : arg,
      );
      return method.apply(this, fallback as Parameters<typeof method>);
    }
  },
};

// Redaction wiring shared by every createLogger branch. `paths` is copied per
// logger because pino types it as a mutable `string[]`.
function secretSafeOptions(level: string): pino.LoggerOptions {
  return {
    level,
    redact: { paths: [...REDACT_PATHS], censor: REDACTION },
    hooks: loggerHooks,
  };
}

// `logger.child({...})` bindings are serialized once at child creation and never
// pass through `logMethod` (and pino resets `formatters.bindings` for children),
// so scrub them on the way in. Patched once on the root: pino builds each child
// with `Object.create(parent)`, so children and grandchildren inherit this
// method and it runs with the right `this` (bindings/level/msgPrefix chain
// intact). `setBindings()` is not covered — no caller uses it.
function scrubChildBindings(logger: Logger): Logger {
  const child = logger.child;
  logger.child = function scrubbedChild(this: Logger, bindings, options) {
    return child.call(this, redactSecretsDeep(bindings), options);
  } as Logger["child"];
  return logger;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  return scrubChildBindings(buildLogger(opts));
}

function buildLogger(opts: LoggerOptions): Logger {
  const level = opts.level ?? "info";
  const { logFile } = opts;

  if (logFile) {
    if (opts.fileOnly) {
      // File only — no stdout (used when TUI dashboard owns the terminal)
      return pino({
        ...secretSafeOptions(level),
        transport: {
          target: "pino/file",
          level: "debug",
          options: { destination: logFile, mkdir: true },
        },
      });
    }
    // Write structured JSON to file, pretty to console
    return pino({
      ...secretSafeOptions(level),
      transport: {
        targets: [
          {
            target: "pino-pretty",
            level,
            options: { colorize: true },
          },
          {
            target: "pino/file",
            level: "debug",
            options: { destination: logFile, mkdir: true },
          },
        ],
      },
    });
  }

  // No log file: write to stderr (fd 2), never stdout (fd 1). A forge-pipeline MCP
  // server speaks JSONRPC over stdout via StdioServerTransport, so any log line on
  // stdout corrupts the protocol stream ("Failed to parse JSONRPC message"). stderr
  // is also the conventional sink for CLI/TUI logs, keeping stdout for program output.
  if (opts.pretty !== false) {
    return pino({
      ...secretSafeOptions(level),
      transport: {
        target: "pino-pretty",
        options: { colorize: true, destination: 2 },
      },
    });
  }

  return pino(secretSafeOptions(level), pino.destination(2));
}

/**
 * Create a child logger with issue context.
 */
export function issueLogger(logger: Logger, issueId: string, identifier: string): Logger {
  return logger.child({ issueId, identifier });
}

/**
 * Create a child logger with session context.
 */
export function sessionLogger(logger: Logger, sessionId: string, workspace: string): Logger {
  return logger.child({ sessionId, workspace });
}
