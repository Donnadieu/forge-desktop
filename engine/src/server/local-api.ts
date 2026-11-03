/**
 * The local API the Forge app talks to. Bound to 127.0.0.1 on a port the OS
 * picks, and every request must carry the token the app handed the engine at
 * launch (`Authorization: Bearer <token>`). No accounts, no CORS, no pages.
 *
 *   GET  /api/v1/state   the whole board state (same shape as each live frame)
 *   POST /api/v1/start   start taking cards
 *   POST /api/v1/stop    stop taking cards (running agents finish first)
 *   POST /api/v1/refresh look at the board now instead of at the next poll
 *   WS   /api/v1/live    pushes the state whenever it changes
 *
 * New in Forge Desktop. Replaces Forge's hosted router.
 */
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Logger } from "pino";
import { WebSocket, WebSocketServer } from "ws";
import { jsonResponse, methodNotAllowed, notFound } from "./http-utils.js";

export interface LocalApiDeps {
  token: string;
  /** The current state, as JSON-ready data. Called on every request and change check. */
  getState: () => unknown;
  start: () => Promise<unknown>;
  stop: () => Promise<unknown>;
  refresh: () => void;
  logger?: Logger;
  /** How often the API checks for a changed state to push (ms). */
  pushCheckMs?: number;
}

export interface LocalApi {
  server: Server;
  port: number;
  /** Push the state now if it changed (call after anything that moves the board). */
  notify: () => void;
  close: () => Promise<void>;
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const given = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function startLocalApi(deps: LocalApiDeps): Promise<LocalApi> {
  if (deps.token.length < 32) throw new Error("the launch token must be at least 32 characters");
  const wss = new WebSocketServer({ noServer: true });
  let lastSent = "";

  const frame = (): string => JSON.stringify({ type: "state", state: deps.getState() });
  const notify = (): void => {
    const next = frame();
    if (next === lastSent) return;
    lastSent = next;
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(next);
    }
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!tokenMatches(req.headers.authorization, deps.token)) {
      jsonResponse(res, 401, { error: "unauthorized" });
      return;
    }
    const path = (req.url ?? "/").split("?")[0];
    const post = req.method === "POST";
    switch (path) {
      case "/api/v1/state":
        if (req.method !== "GET") return methodNotAllowed(res, "GET");
        return jsonResponse(res, 200, deps.getState());
      case "/api/v1/start":
        if (!post) return methodNotAllowed(res, "POST");
        jsonResponse(res, 200, await deps.start());
        return notify();
      case "/api/v1/stop":
        if (!post) return methodNotAllowed(res, "POST");
        jsonResponse(res, 200, await deps.stop());
        return notify();
      case "/api/v1/refresh":
        if (!post) return methodNotAllowed(res, "POST");
        deps.refresh();
        return jsonResponse(res, 202, { ok: true });
      default:
        return notFound(res);
    }
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      deps.logger?.error({ err }, "local API request failed");
      if (!res.headersSent) jsonResponse(res, 500, { error: "internal" });
    });
  });

  server.on("upgrade", (req, socket, head) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path !== "/api/v1/live" || !tokenMatches(req.headers.authorization, deps.token)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      // A new viewer gets the current state at once, then every change.
      ws.send(frame());
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  const timer = setInterval(notify, deps.pushCheckMs ?? 500);
  timer.unref();

  return {
    server,
    port,
    notify,
    close: async () => {
      clearInterval(timer);
      for (const client of wss.clients) client.terminate();
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
