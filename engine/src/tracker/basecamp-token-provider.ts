import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * Basecamp OAuth access tokens are short-lived (~1hr, confirmed live against
 * the ConstructEase account). Forge previously read `FORGE_BASECAMP_API_KEY`
 * once at boot and never refreshed it, so every call started failing with a
 * `401` once the token expired (`BasecampTracker.request`, surfaced through
 * `fetchCandidatesForStages` in both `runStartupSweep` and `pollCycle`). This
 * module adds a token provider abstraction so `BasecampTracker` can refresh
 * before expiry and retry once on a `401`, instead of looping on a dead token.
 */

/** A resolved Basecamp access token, with enough metadata to know when to renew it. */
export interface BasecampTokenSnapshot {
  accessToken: string;
  /** Epoch milliseconds. */
  expiresAtMs: number;
  /** Present when the refresh rotated the refresh token too. */
  refreshToken?: string;
}

/** Resolves a usable Basecamp access token, refreshing it when needed. */
export interface BasecampTokenProvider {
  getAccessToken(options?: { forceRefresh?: boolean }): Promise<string>;
}

/**
 * Thrown when a refresh attempt fails outright (the refresh token itself is
 * dead/revoked, or the refresh mechanism errored). Callers surface this as a
 * clear "needs a human to sign in again" state rather than retrying forever —
 * `message` is safe to show on a dashboard/status endpoint (never contains a
 * token value).
 */
export class BasecampAuthRequiredError extends Error {
  constructor(message = "Basecamp sign-in needed") {
    super(message);
    this.name = "BasecampAuthRequiredError";
  }
}

/** Refresh proactively this long before the token's real expiry. */
const DEFAULT_REFRESH_SKEW_MS = 5 * 60 * 1000;

/** Keeps the current behavior working: a fixed token, never refreshed. */
export class StaticBasecampTokenProvider implements BasecampTokenProvider {
  constructor(private readonly token: string) {}

  async getAccessToken(): Promise<string> {
    return this.token;
  }
}

export interface RefreshingBasecampTokenProviderOptions {
  /** Known-good starting token, if any (skips the first refresh). */
  initial?: BasecampTokenSnapshot;
  /** Performs the actual refresh and returns the new snapshot, or throws. */
  refresh: () => Promise<BasecampTokenSnapshot>;
  /**
   * Called after a successful refresh, with the new snapshot. Used to log
   * "refreshed, expires at …" and nothing else — never pass the access token
   * itself to a logger from here.
   */
  onRefreshed?: (snapshot: BasecampTokenSnapshot) => void;
  /** Called after a refresh attempt fails, with the safe-to-show message. */
  onRefreshFailed?: (message: string) => void;
  now?: () => number;
  refreshSkewMs?: number;
}

/**
 * Refreshes before expiry and on-demand (a `401` mid-run), and is
 * single-flight: concurrent callers during a refresh share the one in-flight
 * attempt rather than hammering the refresh endpoint/command.
 */
export class RefreshingBasecampTokenProvider implements BasecampTokenProvider {
  private snapshot: BasecampTokenSnapshot | undefined;
  private refreshPromise: Promise<string> | undefined;
  private lastErrorMessage: string | undefined;
  private readonly now: () => number;
  private readonly refreshSkewMs: number;

  constructor(private readonly opts: RefreshingBasecampTokenProviderOptions) {
    this.snapshot = opts.initial;
    this.now = opts.now ?? Date.now;
    this.refreshSkewMs = opts.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
  }

  /** Safe-to-display auth status, e.g. for a dashboard/status endpoint. */
  get status(): { ok: boolean; message?: string; expiresAt?: string } {
    if (this.lastErrorMessage) return { ok: false, message: this.lastErrorMessage };
    if (this.snapshot) {
      return { ok: true, expiresAt: new Date(this.snapshot.expiresAtMs).toISOString() };
    }
    return { ok: true };
  }

  async getAccessToken(options?: { forceRefresh?: boolean }): Promise<string> {
    const needsRefresh =
      options?.forceRefresh === true ||
      !this.snapshot ||
      this.snapshot.expiresAtMs - this.refreshSkewMs <= this.now();
    if (!needsRefresh && this.snapshot) return this.snapshot.accessToken;
    return this.refreshSingleFlight();
  }

  private refreshSingleFlight(): Promise<string> {
    if (!this.refreshPromise) {
      this.refreshPromise = this.doRefresh().finally(() => {
        this.refreshPromise = undefined;
      });
    }
    return this.refreshPromise;
  }

  private async doRefresh(): Promise<string> {
    try {
      const snapshot = await this.opts.refresh();
      this.snapshot = snapshot;
      this.lastErrorMessage = undefined;
      this.opts.onRefreshed?.(snapshot);
      return snapshot.accessToken;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const message = `Basecamp sign-in needed: refresh failed (${detail})`;
      this.lastErrorMessage = message;
      this.opts.onRefreshFailed?.(message);
      throw new BasecampAuthRequiredError(message);
    }
  }
}

/**
 * Direct OAuth refresh against Basecamp/37signals Launchpad
 * (`https://launchpad.37signals.com/authorization/token?type=refresh`), the
 * documented path for a long-lived `refresh_token` minted by a full
 * device-code login. Works anywhere Forge runs (Fly included) once the three
 * secrets are configured — no external CLI required.
 */
export function createOAuthRefreshFn(opts: {
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fetchImpl?: typeof fetch;
}): () => Promise<BasecampTokenSnapshot> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  return async () => {
    const response = await fetchImpl(opts.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        type: "refresh",
        refresh_token: opts.refreshToken,
        client_id: opts.clientId,
        client_secret: opts.clientSecret,
      }),
    });
    if (!response.ok) {
      throw new Error(`token endpoint returned ${response.status} ${response.statusText}`);
    }
    const data = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
      refresh_token?: string;
    };
    if (!data.access_token) {
      throw new Error("token endpoint response had no access_token");
    }
    const expiresInMs = (data.expires_in ?? 3600) * 1000;
    return {
      accessToken: data.access_token,
      expiresAtMs: Date.now() + expiresInMs,
      refreshToken: data.refresh_token,
    };
  };
}

/**
 * Delegates the refresh to Omar's own `basecamp` CLI login (made with a full
 * device-code flow, stored under a dedicated `XDG_CONFIG_HOME`). The CLI
 * already knows its own client id/secret and already refreshes its stored
 * token on any call — this just forces one of those calls, then re-reads the
 * credentials file it writes to. Only usable where the `basecamp` binary is
 * installed (Omar's own Mac today); production Fly boxes should use
 * `createOAuthRefreshFn` instead once real client credentials are available.
 */
export function createCliDelegatedRefreshFn(opts: {
  credentialsFile: string;
  xdgConfigHome?: string;
  /** Defaults to a cheap, read-only call that still triggers the CLI's own refresh. */
  command?: string[];
  timeoutMs?: number;
  readFile?: (path: string) => string;
  runCommand?: (command: string[], env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<void>;
}): () => Promise<BasecampTokenSnapshot> {
  const command = opts.command ?? ["basecamp", "auth", "status", "--json"];
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const readFile = opts.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const runCommand = opts.runCommand ?? defaultRunCommand;
  return async () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(opts.xdgConfigHome ? { XDG_CONFIG_HOME: opts.xdgConfigHome } : {}),
    };
    await runCommand(command, env, timeoutMs);
    return readBasecampCredentialsFile(opts.credentialsFile, readFile);
  };
}

/**
 * Asks a command for the token: it prints one JSON line,
 * `{"access_token": "...", "expires_at": <epoch seconds>}`, on stdout. Forge
 * Desktop points this at its own app (`Forge --basecamp-token`), which keeps
 * the sign-in in the Keychain and renews it there, so no refresh token ever
 * reaches the engine, a file or a log.
 */
export function createCommandTokenFn(opts: {
  command: string[];
  timeoutMs?: number;
  runCommand?: (command: string[], timeoutMs: number) => Promise<string>;
}): () => Promise<BasecampTokenSnapshot> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const runCommand = opts.runCommand ?? defaultReadCommand;
  return async () => {
    const out = await runCommand(opts.command, timeoutMs);
    let data: { access_token?: string; expires_at?: number };
    try {
      data = JSON.parse(out.trim().split("\n").pop() ?? "") as typeof data;
    } catch {
      throw new Error("the sign-in command printed no token");
    }
    if (!data.access_token || !data.expires_at) {
      throw new Error("the sign-in command printed no token");
    }
    return { accessToken: data.access_token, expiresAtMs: data.expires_at * 1000 };
  };
}

function defaultReadCommand(command: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const [bin, ...args] = command;
    if (!bin) {
      reject(new Error("the sign-in command is empty"));
      return;
    }
    execFile(bin, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        // stderr carries the app's plain-words reason ("Sign in to Basecamp again").
        const why =
          String(stderr ?? "")
            .trim()
            .split("\n")
            .pop() || error.message;
        reject(new Error(why));
        return;
      }
      resolvePromise(String(stdout));
    });
  });
}

function defaultRunCommand(
  command: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const [bin, ...args] = command;
    if (!bin) {
      reject(new Error("refresh command is empty"));
      return;
    }
    execFile(bin, args, { env, timeout: timeoutMs }, (error) => {
      if (error) {
        reject(new Error(`refresh command '${command.join(" ")}' failed: ${error.message}`));
        return;
      }
      resolvePromise();
    });
  });
}

/**
 * Parses the `basecamp` CLI's own credentials file shape:
 * `{ "<base-url>": { access_token, refresh_token, expires_at (epoch seconds) } }`.
 * Only one entry is expected per profile; the first usable one wins.
 */
function readBasecampCredentialsFile(
  path: string,
  readFile: (path: string) => string,
): BasecampTokenSnapshot {
  const raw = readFile(path);
  const parsed = JSON.parse(raw) as Record<
    string,
    { access_token?: string; refresh_token?: string; expires_at?: number } | undefined
  >;
  const entry = Object.values(parsed).find((v) => v?.access_token);
  if (!entry?.access_token || !entry.expires_at) {
    throw new Error("credentials file has no usable access_token/expires_at after refresh");
  }
  return {
    accessToken: entry.access_token,
    expiresAtMs: entry.expires_at * 1000,
    refreshToken: entry.refresh_token,
  };
}
