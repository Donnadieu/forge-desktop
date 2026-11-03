import type { IncomingMessage, ServerResponse } from "node:http";

export function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Canonical 404 body — byte-identical to the router's own so a gated-off route can't be told apart. */
export function notFound(res: ServerResponse): void {
  jsonResponse(res, 404, { error: { code: "not_found", message: "Route not found" } });
}

/** Canonical 405 body for a matched route reached with the wrong method. */
export function methodNotAllowed(res: ServerResponse, method: string): void {
  jsonResponse(res, 405, {
    error: { code: "method_not_allowed", message: `${method} not allowed` },
  });
}

/**
 * Query params of a request. Parses off `req.url` directly rather than through
 * `new URL(...)`, which would need an origin the router does not have.
 */
export function queryParams(req: IncomingMessage): URLSearchParams {
  const rawUrl = req.url ?? "";
  const qIndex = rawUrl.indexOf("?");
  return new URLSearchParams(qIndex === -1 ? "" : rawUrl.slice(qIndex + 1));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * Escape a string for interpolation into server-rendered HTML.
 * Shared by every `*-html.ts` renderer so an app name or label can't inject
 * markup. Mirrors the dashboard's client-side `esc()` helper.
 *
 * Safe-context contract: this escapes `& < > "` — enough for element text and
 * double-quoted attribute values, which is every current call site. It does NOT
 * escape single quotes, so a value interpolated into a SINGLE-quoted attribute
 * (`title='...'`) would not be safe. Keep interpolations in text or
 * double-quoted attributes; extend this helper before introducing a
 * single-quoted-attribute sink.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Serialize a value for interpolation into an inline `<script>` block. `<` is
 * escaped so the JSON can never break out of the tag (`</script>` or a comment
 * opener). Shared by every `*-html.ts` renderer so the guard can be hardened in
 * one place.
 */
export function safeJsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

export class BodyReadError extends Error {
  constructor(
    message: string,
    readonly kind: "too_large" | "invalid_json" | "empty" | "bad_content_type",
  ) {
    super(message);
    this.name = "BodyReadError";
  }
}

/** Asserts `Content-Type` starts with `application/json`. Throws BodyReadError otherwise. */
export function requireJsonContentType(req: IncomingMessage): void {
  const ct = req.headers?.["content-type"];
  if (typeof ct !== "string" || !ct.toLowerCase().startsWith("application/json")) {
    throw new BodyReadError("Content-Type must be application/json", "bad_content_type");
  }
}

/**
 * Buffers a request body up to `maxBytes`, destroying the request and rejecting
 * with `BodyReadError("too_large")` if the cap is exceeded, or
 * `BodyReadError("empty")` if nothing arrived. Stream errors propagate raw (not
 * wrapped) so callers can distinguish transport failures. Shared by the JSON
 * reader below and the raw-body webhook routes (Stripe, GitHub deploy-hook)
 * whose HMAC verification needs the exact bytes.
 */
export function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      received += chunk.length;
      if (received > maxBytes) {
        finish(() => reject(new BodyReadError("request body too large", "too_large")));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      finish(() => {
        if (chunks.length === 0) {
          reject(new BodyReadError("request body is empty", "empty"));
          return;
        }
        resolve(Buffer.concat(chunks));
      });
    });

    req.on("error", (err) => {
      finish(() => reject(err));
    });
  });
}

export async function readJsonBody(req: IncomingMessage, maxBytes = 4096): Promise<unknown> {
  const raw = await readRawBody(req, maxBytes);
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw new BodyReadError("request body is not valid JSON", "invalid_json");
  }
}
