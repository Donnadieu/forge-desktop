import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BasecampAuthRequiredError,
  createCliDelegatedRefreshFn,
  createOAuthRefreshFn,
  RefreshingBasecampTokenProvider,
  StaticBasecampTokenProvider,
} from "../../../src/tracker/basecamp-token-provider.js";

describe("StaticBasecampTokenProvider", () => {
  it("always returns the fixed token, never refreshes", async () => {
    const provider = new StaticBasecampTokenProvider("bc_at_fixed");
    expect(await provider.getAccessToken()).toBe("bc_at_fixed");
    expect(await provider.getAccessToken({ forceRefresh: true })).toBe("bc_at_fixed");
  });
});

describe("RefreshingBasecampTokenProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refreshes on first use when there is no initial token", async () => {
    const refresh = vi.fn().mockResolvedValue({
      accessToken: "bc_at_new",
      expiresAtMs: Date.now() + 3_600_000,
    });
    const provider = new RefreshingBasecampTokenProvider({ refresh });

    const token = await provider.getAccessToken();

    expect(token).toBe("bc_at_new");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("expired token -> refresh -> success: refreshes proactively once the token is within the skew window", async () => {
    const now = 1_000_000;
    const refresh = vi.fn().mockResolvedValue({
      accessToken: "bc_at_renewed",
      expiresAtMs: now + 3_600_000,
    });
    const provider = new RefreshingBasecampTokenProvider({
      refresh,
      now: () => now,
      initial: { accessToken: "bc_at_stale", expiresAtMs: now + 1_000 }, // expires in 1s, well inside the skew window
    });

    const token = await provider.getAccessToken();

    expect(token).toBe("bc_at_renewed");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not refresh when the cached token is still comfortably valid", async () => {
    const now = 1_000_000;
    const refresh = vi.fn();
    const provider = new RefreshingBasecampTokenProvider({
      refresh,
      now: () => now,
      initial: { accessToken: "bc_at_good", expiresAtMs: now + 3_600_000 },
    });

    const token = await provider.getAccessToken();

    expect(token).toBe("bc_at_good");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("401 mid-run -> forceRefresh -> retry: a forced refresh bypasses the cached token even when it looks valid", async () => {
    const now = 1_000_000;
    const refresh = vi.fn().mockResolvedValue({
      accessToken: "bc_at_after_401",
      expiresAtMs: now + 3_600_000,
    });
    const provider = new RefreshingBasecampTokenProvider({
      refresh,
      now: () => now,
      initial: { accessToken: "bc_at_rejected", expiresAtMs: now + 3_600_000 },
    });

    const token = await provider.getAccessToken({ forceRefresh: true });

    expect(token).toBe("bc_at_after_401");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("refresh fails -> clear status: throws BasecampAuthRequiredError and reports it on .status without ever exposing a token", async () => {
    const refresh = vi.fn().mockRejectedValue(new Error("refresh_token revoked"));
    const provider = new RefreshingBasecampTokenProvider({ refresh });

    await expect(provider.getAccessToken()).rejects.toBeInstanceOf(BasecampAuthRequiredError);
    await expect(provider.getAccessToken()).rejects.toThrow(/Basecamp sign-in needed/);

    expect(provider.status.ok).toBe(false);
    expect(provider.status.message).toContain("Basecamp sign-in needed");
    expect(provider.status.message).toContain("refresh_token revoked");
    expect(provider.status.message).not.toMatch(/bc_at_|bc_rt_/);
  });

  it("is single-flight: concurrent callers during a refresh share one in-flight attempt", async () => {
    let resolveRefresh: (value: { accessToken: string; expiresAtMs: number }) => void = () => {};
    const refresh = vi.fn().mockImplementation(
      () =>
        new Promise((resolvePromise) => {
          resolveRefresh = resolvePromise;
        }),
    );
    const provider = new RefreshingBasecampTokenProvider({ refresh });

    const first = provider.getAccessToken();
    const second = provider.getAccessToken();
    const third = provider.getAccessToken({ forceRefresh: true });

    resolveRefresh({ accessToken: "bc_at_shared", expiresAtMs: Date.now() + 3_600_000 });
    const [a, b, c] = await Promise.all([first, second, third]);

    expect(a).toBe("bc_at_shared");
    expect(b).toBe("bc_at_shared");
    expect(c).toBe("bc_at_shared");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("recovers after a failed refresh — a later successful refresh clears the error status", async () => {
    const refresh = vi
      .fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({
        accessToken: "bc_at_recovered",
        expiresAtMs: Date.now() + 3_600_000,
      });
    const provider = new RefreshingBasecampTokenProvider({ refresh });

    await expect(provider.getAccessToken()).rejects.toBeInstanceOf(BasecampAuthRequiredError);
    expect(provider.status.ok).toBe(false);

    const token = await provider.getAccessToken({ forceRefresh: true });

    expect(token).toBe("bc_at_recovered");
    expect(provider.status.ok).toBe(true);
  });

  it("calls onRefreshed with only the expiry, never the token value", async () => {
    const onRefreshed = vi.fn();
    const expiresAtMs = Date.now() + 3_600_000;
    const refresh = vi.fn().mockResolvedValue({ accessToken: "bc_at_secret", expiresAtMs });
    const provider = new RefreshingBasecampTokenProvider({ refresh, onRefreshed });

    await provider.getAccessToken();

    expect(onRefreshed).toHaveBeenCalledWith({ accessToken: "bc_at_secret", expiresAtMs });
  });
});

describe("createOAuthRefreshFn", () => {
  it("POSTs a refresh grant to the configured token endpoint and returns the new snapshot", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ access_token: "bc_at_oauth", expires_in: 3600 }),
    });
    const refreshFn = createOAuthRefreshFn({
      tokenEndpoint: "https://launchpad.37signals.com/authorization/token?type=refresh",
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshToken: "bc_rt_abc",
      fetchImpl,
    });

    const snapshot = await refreshFn();

    expect(snapshot.accessToken).toBe("bc_at_oauth");
    expect(snapshot.expiresAtMs).toBeGreaterThan(Date.now());
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://launchpad.37signals.com/authorization/token?type=refresh");
    const body = (init as RequestInit).body as URLSearchParams;
    expect(body.get("refresh_token")).toBe("bc_rt_abc");
    expect(body.get("client_id")).toBe("client-id");
    expect(body.get("client_secret")).toBe("client-secret");
    expect(body.get("type")).toBe("refresh");
  });

  it("surfaces a rotated refresh token when the response carries one", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        access_token: "bc_at_oauth",
        expires_in: 3600,
        refresh_token: "bc_rt_rotated",
      }),
    });
    const refreshFn = createOAuthRefreshFn({
      tokenEndpoint: "https://launchpad.37signals.com/authorization/token?type=refresh",
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshToken: "bc_rt_abc",
      fetchImpl,
    });

    const snapshot = await refreshFn();

    expect(snapshot.refreshToken).toBe("bc_rt_rotated");
  });

  it("throws a non-sensitive error on a non-OK response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      json: async () => ({}),
    });
    const refreshFn = createOAuthRefreshFn({
      tokenEndpoint: "https://example.test/token",
      clientId: "id",
      clientSecret: "secret",
      refreshToken: "bc_rt_dead",
      fetchImpl,
    });

    await expect(refreshFn()).rejects.toThrow(/401/);
  });

  it("throws when the response has no access_token", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({}),
    });
    const refreshFn = createOAuthRefreshFn({
      tokenEndpoint: "https://example.test/token",
      clientId: "id",
      clientSecret: "secret",
      refreshToken: "bc_rt_dead",
      fetchImpl,
    });

    await expect(refreshFn()).rejects.toThrow(/access_token/);
  });
});

describe("createCliDelegatedRefreshFn", () => {
  it("runs the refresh command, then reads the freshly-written credentials file", async () => {
    const runCommand = vi.fn().mockResolvedValue(undefined);
    const readFile = vi.fn().mockReturnValue(
      JSON.stringify({
        "https://3.basecampapi.com": {
          access_token: "bc_at_from_file",
          refresh_token: "bc_rt_from_file",
          expires_at: 1_793_651_401,
        },
      }),
    );
    const refreshFn = createCliDelegatedRefreshFn({
      credentialsFile: "/tmp/basecamp-credentials.json",
      xdgConfigHome: "/tmp/basecamp-home",
      runCommand,
      readFile,
    });

    const snapshot = await refreshFn();

    expect(snapshot.accessToken).toBe("bc_at_from_file");
    expect(snapshot.refreshToken).toBe("bc_rt_from_file");
    expect(snapshot.expiresAtMs).toBe(1_793_651_401_000);
    expect(runCommand).toHaveBeenCalledTimes(1);
    const [command, env] = runCommand.mock.calls[0];
    expect(command).toEqual(["basecamp", "auth", "status", "--json"]);
    expect(env.XDG_CONFIG_HOME).toBe("/tmp/basecamp-home");
  });

  it("honors a custom refresh command override", async () => {
    const runCommand = vi.fn().mockResolvedValue(undefined);
    const readFile = vi
      .fn()
      .mockReturnValue(JSON.stringify({ x: { access_token: "a", expires_at: 1 } }));
    const refreshFn = createCliDelegatedRefreshFn({
      credentialsFile: "/tmp/creds.json",
      command: ["basecamp", "projects", "list"],
      runCommand,
      readFile,
    });

    await refreshFn();

    expect(runCommand.mock.calls[0][0]).toEqual(["basecamp", "projects", "list"]);
  });

  it("refresh fails -> clear status: a non-zero command exit surfaces as a clean error, not a crash", async () => {
    const runCommand = vi.fn().mockRejectedValue(new Error("exit code 1"));
    const readFile = vi.fn();
    const refreshFn = createCliDelegatedRefreshFn({
      credentialsFile: "/tmp/creds.json",
      runCommand,
      readFile,
    });

    await expect(refreshFn()).rejects.toThrow(/exit code 1/);
    expect(readFile).not.toHaveBeenCalled();
  });

  it("throws when the credentials file has no usable token after the refresh command ran", async () => {
    const runCommand = vi.fn().mockResolvedValue(undefined);
    const readFile = vi.fn().mockReturnValue(JSON.stringify({ x: { scope: "full" } }));
    const refreshFn = createCliDelegatedRefreshFn({
      credentialsFile: "/tmp/creds.json",
      runCommand,
      readFile,
    });

    await expect(refreshFn()).rejects.toThrow(/no usable access_token/);
  });
});
