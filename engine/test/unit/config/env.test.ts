import { afterEach, describe, expect, it } from "vitest";
import { getEnv, parseEnv, resetEnvCache } from "../../../src/config/env.js";

describe("EnvSchema", () => {
  it("parses an empty environment with defaults", () => {
    const env = parseEnv({});
    expect(env.FORGE_LINEAR_STATE_TODO).toBe("Todo");
    expect(env.FORGE_LINEAR_LABEL_BUG).toBe("smith_bug");
    expect(env.FLY_API_BASE_URL).toBe("https://api.machines.dev/v1");
    expect(env.OLLAMA_HOST).toBe("http://localhost:11434");
    expect(env.FORGE_WORKER_APP).toBe("forge-workers");
    expect(env.FORGE_LOCAL_WORKER_NETWORK).toBe("forge-local");
    expect(env.FORGE_KEEP_ALIVE).toBe(false);
    expect(env.FORGE_TRUSTED_SPAWN).toBe(false);
    expect(env.LINEAR_API_KEY).toBeUndefined();
  });

  it("coerces boolean flags from common truthy strings", () => {
    for (const raw of ["true", "1", "yes", "on", "TRUE"]) {
      const env = parseEnv({ FORGE_KEEP_ALIVE: raw });
      expect(env.FORGE_KEEP_ALIVE).toBe(true);
    }
  });

  it("coerces boolean flags from common falsy strings", () => {
    for (const raw of ["false", "0", "no", "off", "FALSE"]) {
      const env = parseEnv({ FORGE_KEEP_ALIVE: raw });
      expect(env.FORGE_KEEP_ALIVE).toBe(false);
    }
  });

  it("tolerates surrounding whitespace around boolean tokens", () => {
    // Routing booleanFlag through parseBooleanToken (which trims) means a padded
    // token like " true " now coerces instead of throwing — a deliberate,
    // fleet-wide leniency across every booleanFlag. Pin it so it isn't lost.
    expect(parseEnv({ FORGE_KEEP_ALIVE: " true " }).FORGE_KEEP_ALIVE).toBe(true);
    expect(parseEnv({ FORGE_KEEP_ALIVE: " 0 " }).FORGE_KEEP_ALIVE).toBe(false);
  });

  it("defaults boolean flags to false when unset or empty", () => {
    expect(parseEnv({}).FORGE_KEEP_ALIVE).toBe(false);
    expect(parseEnv({ FORGE_KEEP_ALIVE: "" }).FORGE_KEEP_ALIVE).toBe(false);
  });

  it("rejects invalid boolean flag values", () => {
    expect(() => parseEnv({ FORGE_KEEP_ALIVE: "maybe" })).toThrow();
  });

  it("treats the custom-workflows master flag as a plain boolean (FRG-2005)", () => {
    // FORGE_CUSTOM_WORKFLOWS_ENABLED is a booleanFlag — true/false only. Pilot
    // scoping lives in the separate FORGE_CUSTOM_WORKFLOWS_APPS string.
    expect(
      parseEnv({ FORGE_CUSTOM_WORKFLOWS_ENABLED: "true" }).FORGE_CUSTOM_WORKFLOWS_ENABLED,
    ).toBe(true);
    expect(parseEnv({}).FORGE_CUSTOM_WORKFLOWS_ENABLED).toBe(false);
    expect(() => parseEnv({ FORGE_CUSTOM_WORKFLOWS_ENABLED: "some-uuid" })).toThrow();
    const uuid = "3f1e4a2b-0c5d-4e6f-8a9b-0c1d2e3f4a5b";
    expect(
      parseEnv({ FORGE_CUSTOM_WORKFLOWS_APPS: `${uuid},${uuid}` }).FORGE_CUSTOM_WORKFLOWS_APPS,
    ).toBe(`${uuid},${uuid}`);
  });

  it("declares FORGE_BYOK_MODE as a booleanFlag defaulting to false (FRG-2066)", () => {
    // BYOK mode is the de-billing master switch: default OFF so the billed
    // journey stays byte-identical, and it coerces via the shared boolean tokens.
    expect(parseEnv({}).FORGE_BYOK_MODE).toBe(false);
    expect(parseEnv({ FORGE_BYOK_MODE: "" }).FORGE_BYOK_MODE).toBe(false);
    for (const raw of ["true", "1", "yes", "on"]) {
      expect(parseEnv({ FORGE_BYOK_MODE: raw }).FORGE_BYOK_MODE).toBe(true);
    }
    for (const raw of ["false", "0", "no", "off"]) {
      expect(parseEnv({ FORGE_BYOK_MODE: raw }).FORGE_BYOK_MODE).toBe(false);
    }
    expect(() => parseEnv({ FORGE_BYOK_MODE: "maybe" })).toThrow();
  });

  it("coerces numeric env vars", () => {
    const env = parseEnv({ FORGE_MAX_TURNS: "100", FORGE_MAX_BUILD_USD: "50" });
    expect(env.FORGE_MAX_TURNS).toBe(100);
    expect(env.FORGE_MAX_BUILD_USD).toBe(50);
  });

  it("treats empty numeric env vars as undefined", () => {
    const env = parseEnv({ FORGE_MAX_TURNS: "" });
    expect(env.FORGE_MAX_TURNS).toBeUndefined();
  });

  it("rejects invalid numeric env vars", () => {
    expect(() => parseEnv({ FORGE_MAX_TURNS: "abc" })).toThrow();
  });

  it("preserves string secrets", () => {
    const env = parseEnv({
      LINEAR_API_KEY: "lin_test",
      ANTHROPIC_API_KEY: "ant_test",
      DATABASE_URL: "postgres://test",
    });
    expect(env.LINEAR_API_KEY).toBe("lin_test");
    expect(env.ANTHROPIC_API_KEY).toBe("ant_test");
    expect(env.DATABASE_URL).toBe("postgres://test");
  });

  it("ignores unknown env vars", () => {
    const env = parseEnv({ SOME_RANDOM_VAR: "value" } as NodeJS.ProcessEnv);
    expect((env as Record<string, unknown>).SOME_RANDOM_VAR).toBeUndefined();
  });
});

describe("getEnv", () => {
  afterEach(() => {
    resetEnvCache();
  });

  it("caches the parsed environment", () => {
    const first = getEnv();
    const second = getEnv();
    expect(first).toBe(second);
  });

  it("re-parses after reset", () => {
    const first = getEnv();
    resetEnvCache();
    const second = getEnv();
    expect(first).not.toBe(second);
    expect(second.FORGE_KEEP_ALIVE).toBe(false);
  });
});

describe("EnvSchema strictness", () => {
  it("rejects a non-numeric FORGE_FREE_DISCOVERY_SESSIONS_PER_HOUR", () => {
    expect(() => parseEnv({ FORGE_FREE_DISCOVERY_SESSIONS_PER_HOUR: "lots" })).toThrow();
  });

  it("accepts a numeric FORGE_FREE_DISCOVERY_SESSIONS_PER_HOUR", () => {
    const env = parseEnv({ FORGE_FREE_DISCOVERY_SESSIONS_PER_HOUR: "10" });
    expect(env.FORGE_FREE_DISCOVERY_SESSIONS_PER_HOUR).toBe(10);
  });
});
