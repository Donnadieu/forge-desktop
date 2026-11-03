import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  BodyReadError,
  isUuid,
  jsonResponse,
  readJsonBody,
  readRawBody,
} from "../../../src/server/http-utils.js";

class MockReq extends EventEmitter {
  destroy = vi.fn();
}

function makeRes(): ServerResponse & {
  writeHead: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
} {
  const writeHead = vi.fn();
  const end = vi.fn();
  return { writeHead, end } as unknown as ServerResponse & {
    writeHead: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
}

async function emit(req: MockReq, chunks: Buffer[], { withEnd = true } = {}): Promise<void> {
  await new Promise((r) => setImmediate(r));
  for (const chunk of chunks) req.emit("data", chunk);
  if (withEnd) req.emit("end");
}

describe("readJsonBody", () => {
  it("parses a valid JSON body", async () => {
    const req = new MockReq();
    const p = readJsonBody(req as unknown as IncomingMessage);
    await emit(req, [Buffer.from(JSON.stringify({ foo: "bar" }), "utf8")]);
    expect(await p).toEqual({ foo: "bar" });
  });

  it("supports chunked bodies that straddle the max-bytes boundary", async () => {
    const req = new MockReq();
    const payload = { k: "x".repeat(900) };
    const raw = Buffer.from(JSON.stringify(payload), "utf8");
    const mid = Math.floor(raw.length / 2);
    const p = readJsonBody(req as unknown as IncomingMessage, raw.length);
    await emit(req, [raw.subarray(0, mid), raw.subarray(mid)]);
    expect(await p).toEqual(payload);
  });

  it("rejects when body exceeds maxBytes and destroys the request", async () => {
    const req = new MockReq();
    const p = readJsonBody(req as unknown as IncomingMessage, 8);
    await emit(req, [Buffer.from("123456789"), Buffer.from("0")], { withEnd: false });
    await expect(p).rejects.toMatchObject({ name: "BodyReadError", kind: "too_large" });
    expect(req.destroy).toHaveBeenCalled();
  });

  it("rejects empty bodies with kind=empty", async () => {
    const req = new MockReq();
    const p = readJsonBody(req as unknown as IncomingMessage);
    await emit(req, []);
    await expect(p).rejects.toMatchObject({ name: "BodyReadError", kind: "empty" });
  });

  it("rejects invalid JSON with kind=invalid_json", async () => {
    const req = new MockReq();
    const p = readJsonBody(req as unknown as IncomingMessage);
    await emit(req, [Buffer.from("{ not json")]);
    await expect(p).rejects.toMatchObject({ name: "BodyReadError", kind: "invalid_json" });
  });

  it("propagates stream errors (not as BodyReadError)", async () => {
    const req = new MockReq();
    const p = readJsonBody(req as unknown as IncomingMessage);
    const err = new Error("boom");
    await new Promise((r) => setImmediate(r));
    req.emit("error", err);
    await expect(p).rejects.toBe(err);
  });

  it("is safe against double-end events", async () => {
    const req = new MockReq();
    const p = readJsonBody(req as unknown as IncomingMessage);
    await emit(req, [Buffer.from('"ok"')]);
    req.emit("end"); // second end; should not re-reject
    expect(await p).toBe("ok");
  });

  it("ignores further data chunks after the too-large rejection fires", async () => {
    const req = new MockReq();
    const p = readJsonBody(req as unknown as IncomingMessage, 4);
    await emit(req, [Buffer.from("12345")], { withEnd: false });
    await expect(p).rejects.toMatchObject({ kind: "too_large" });
    // Emitting more data after settlement must not crash or re-resolve.
    expect(() => req.emit("data", Buffer.from("x"))).not.toThrow();
  });
});

describe("readRawBody", () => {
  it("resolves the exact concatenated bytes (HMAC-critical: no re-encode)", async () => {
    // The GitHub/Stripe webhook HMAC is computed over these exact bytes, so a
    // chunked body must resolve byte-for-byte identical to the original buffer.
    const req = new MockReq();
    const raw = Buffer.from('{"ref":"refs/heads/main","emoji":"✅"}', "utf8");
    const mid = Math.floor(raw.length / 2);
    const p = readRawBody(req as unknown as IncomingMessage, 4096);
    await emit(req, [raw.subarray(0, mid), raw.subarray(mid)]);
    const got = await p;
    expect(Buffer.isBuffer(got)).toBe(true);
    expect(got.equals(raw)).toBe(true);
  });

  it("rejects an empty body with kind=empty", async () => {
    const req = new MockReq();
    const p = readRawBody(req as unknown as IncomingMessage, 4096);
    await emit(req, []);
    await expect(p).rejects.toMatchObject({ name: "BodyReadError", kind: "empty" });
  });

  it("rejects and destroys the request when the body exceeds maxBytes", async () => {
    const req = new MockReq();
    const p = readRawBody(req as unknown as IncomingMessage, 4);
    await emit(req, [Buffer.from("12345")], { withEnd: false });
    await expect(p).rejects.toMatchObject({ name: "BodyReadError", kind: "too_large" });
    expect(req.destroy).toHaveBeenCalled();
  });
});

describe("isUuid", () => {
  it("accepts canonical UUID shapes (lowercase and uppercase)", () => {
    expect(isUuid("00000000-0000-0000-0000-000000000000")).toBe(true);
    expect(isUuid("DEADBEEF-1234-5678-9ABC-DEF012345678")).toBe(true);
  });

  it("rejects wrong-length, non-hex, or malformed strings", () => {
    expect(isUuid("")).toBe(false);
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid("00000000-0000-0000-0000-00000000000")).toBe(false); // 11 in last group
    expect(isUuid("00000000-0000-0000-0000-0000000000000")).toBe(false); // 13 in last group
    expect(isUuid("zzzzzzzz-0000-0000-0000-000000000000")).toBe(false);
    expect(isUuid("00000000-0000-0000-0000-00000000000g")).toBe(false);
  });
});

describe("jsonResponse", () => {
  it("writes the content-type header, serialises the body, and ends the response", () => {
    const res = makeRes();
    jsonResponse(res, 201, { ok: true });
    expect(res.writeHead).toHaveBeenCalledWith(201, { "Content-Type": "application/json" });
    expect(res.end).toHaveBeenCalledWith(JSON.stringify({ ok: true }));
  });
});

describe("BodyReadError", () => {
  it("carries the discriminant kind and preserves the message", () => {
    const err = new BodyReadError("test", "too_large");
    expect(err.name).toBe("BodyReadError");
    expect(err.kind).toBe("too_large");
    expect(err.message).toBe("test");
    expect(err).toBeInstanceOf(Error);
  });
});
