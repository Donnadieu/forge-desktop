import { describe, expect, it } from "vitest";
import { BOOLEAN_TRUE_TOKENS, parseBooleanToken } from "../../../src/config/boolean-token.js";

/**
 * Direct contract test for the canonical boolean coercion. This module underpins
 * every `booleanFlag` in the env schema plus the custom_workflows gate, so its
 * token table and — critically — its three-valued (`true`/`false`/`undefined`)
 * return contract are pinned here rather than only exercised transitively through
 * callers. The `undefined`-for-unrecognized case is load-bearing: `booleanFlag`
 * relies on it to fall through to `z.boolean()` (fail-fast), and the gate relies
 * on it via `=== true` (unrecognized ⇒ off).
 */
describe("parseBooleanToken", () => {
  it("coerces every truthy spelling to true, case- and whitespace-insensitively", () => {
    for (const raw of ["1", "true", "on", "yes", "TRUE", "On", " true ", " 1 ", "\tyes\n"]) {
      expect(parseBooleanToken(raw), `${JSON.stringify(raw)} should be true`).toBe(true);
    }
  });

  it("coerces every falsy spelling to false, case- and whitespace-insensitively", () => {
    for (const raw of ["0", "false", "off", "no", "FALSE", "Off", " false ", " 0 "]) {
      expect(parseBooleanToken(raw), `${JSON.stringify(raw)} should be false`).toBe(false);
    }
  });

  it("returns undefined (NOT false) for unrecognized or empty tokens", () => {
    for (const raw of ["", "  ", "maybe", "2", "app-uuid", "truthy", "yeah", undefined]) {
      expect(parseBooleanToken(raw), `${JSON.stringify(raw)} should be undefined`).toBeUndefined();
    }
  });

  it("distinguishes unrecognized (undefined) from falsy (false)", () => {
    // These two must not collapse: callers apply their own default only on
    // undefined, and treat an explicit falsy token as a real `false`.
    expect(parseBooleanToken("garbage")).toBeUndefined();
    expect(parseBooleanToken("false")).toBe(false);
  });
});

describe("BOOLEAN_TRUE_TOKENS", () => {
  it("is the exact canonical truthy set (golden list — a token edit trips here)", () => {
    // Golden assertion so adding/removing a spelling is a named, obvious failure
    // rather than only a transitive one, and so the cross-language Python mirror
    // (public-context-python.test.ts) has a stable anchor to pin against.
    expect([...BOOLEAN_TRUE_TOKENS]).toEqual(["1", "true", "on", "yes"]);
  });

  it("every listed token actually parses to true", () => {
    for (const token of BOOLEAN_TRUE_TOKENS) {
      expect(parseBooleanToken(token)).toBe(true);
    }
  });
});
