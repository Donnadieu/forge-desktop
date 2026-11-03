import { redactSecretsFromString } from "../observability/secret-redact.js";

/**
 * The one raw stderr sink in `src/mcp` (FRG-2081): every line goes through the
 * shared secret redactor first, because these lines carry uncontrolled text —
 * error messages, Fly response bodies, handler context. Pino output is already
 * redacted by `createLogger`; this covers the plain-text breadcrumbs that skip
 * it. `test/architecture/conventions.test.ts` bans bare
 * `process.stderr.write` elsewhere under `src/mcp`.
 */
export function writeStderr(line: string): void {
  process.stderr.write(`${redactSecretsFromString(line)}\n`);
}

/** Failed handler calls leave a breadcrumb without dragging the logger in. */
export function logHandlerError(tool: string, ctx: Record<string, unknown>, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  writeStderr(`[smith:${tool}] ${message} ${JSON.stringify(ctx)}`);
}

/**
 * Structured audit log for Smith-scoped mutations. Writes a single JSON line to
 * stderr with who/what/when so log scrapers can reconstruct status changes.
 *
 * Keep this in mcp/* (not observability) to respect the module boundary: the
 * audit event is emitted at the tool-handler boundary where the actor and
 * target are known.
 */
export function logSmithAudit(
  tool: string,
  ctx: {
    userId: string;
    action: string;
    target: Record<string, unknown>;
    meta?: Record<string, unknown>;
  },
): void {
  const entry = {
    ts: new Date().toISOString(),
    actor: ctx.userId,
    action: ctx.action,
    target: ctx.target,
    ...(ctx.meta ? { meta: ctx.meta } : {}),
  };
  writeStderr(`[smith:audit:${tool}] ${JSON.stringify(entry)}`);
}
