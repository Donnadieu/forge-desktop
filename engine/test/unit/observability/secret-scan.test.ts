import { describe, expect, it } from "vitest";
import {
  looksLikeLiveCredential,
  scanContentForSecrets,
  scanFilesForSecrets,
} from "../../../src/observability/secret-scan.js";

// FRG-2081: the fail-closed scanner behind post-stamp pushes. A hit names only
// the env var or the shape label — never the value.
const VALUE = "live-value-0123456789abcdef";
const GH_SHAPE = `ghp_${"aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5"}`;

describe("scanFilesForSecrets", () => {
  it("flags a live env value by name, never by value", () => {
    const hit = scanFilesForSecrets([{ path: "src/a.ts", data: Buffer.from(`k=${VALUE}`) }], {
      GH_TOKEN: VALUE,
    });
    expect(hit).toBe("src/a.ts: matches a known secret value ($GH_TOKEN)");
    expect(hit).not.toContain(VALUE);
  });

  it("flags a live credential shape by label", () => {
    const hit = scanFilesForSecrets([{ path: "b.env", data: Buffer.from(`T=${GH_SHAPE}`) }], {});
    expect(hit).toBe("b.env: contains a GitHub token");
    expect(hit).not.toContain(GH_SHAPE);
  });

  it("passes placeholders and short env values", () => {
    const placeholder = `ghp_${"yourtokenhere".padEnd(36, "x")}`;
    expect(
      scanFilesForSecrets([{ path: ".env.example", data: Buffer.from(`T=${placeholder} short`) }], {
        GH_TOKEN: "short",
      }),
    ).toBeNull();
  });

  it("matches exact values in binary content but skips shapes there", () => {
    const bin = Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(GH_SHAPE)]);
    expect(scanContentForSecrets("x.bin", bin, [])).toBeNull();
    const withValue = Buffer.concat([Buffer.from([0]), Buffer.from(VALUE)]);
    expect(scanContentForSecrets("x.bin", withValue, [{ name: "GH_TOKEN", value: VALUE }])).toBe(
      "x.bin: matches a known secret value ($GH_TOKEN)",
    );
  });

  it("returns the first hit across files", () => {
    const hit = scanFilesForSecrets(
      [
        { path: "clean.txt", data: Buffer.from("nothing") },
        { path: "dirty.txt", data: Buffer.from(GH_SHAPE) },
      ],
      {},
    );
    expect(hit).toBe("dirty.txt: contains a GitHub token");
  });
});

describe("looksLikeLiveCredential", () => {
  it("rejects low-entropy and placeholder bodies", () => {
    expect(looksLikeLiveCredential("aaaaaaaaaaaaaaaaaaaaaaaa")).toBe(false);
    expect(looksLikeLiveCredential("replace0with0your0real0key")).toBe(false);
    expect(looksLikeLiveCredential("aB3dE5gH7jK9mN1pQ3sT5vW7")).toBe(true);
  });
});
