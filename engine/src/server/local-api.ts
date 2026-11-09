/**
 * The local API the Forge app talks to. Bound to 127.0.0.1 on a port the OS
 * picks, and every request must carry the token the app handed the engine at
 * launch (`Authorization: Bearer <token>`). No accounts, no CORS, no pages.
 *
 *   GET  /api/v1/state   the whole board state (same shape as each live frame)
 *   POST /api/v1/start   start taking cards
 *   POST /api/v1/stop    stop taking cards; answers at once, running agents finish in the background
 *   POST /api/v1/refresh look at the board now instead of at the next poll
 *   GET  /api/v1/cards/<id>/workpad  the card's workpad note, for the card's detail
 *   POST /api/v1/cards/<id>/move     `{"to": "<column>"}`: the person moves a card (Start, Merge, Ask for changes)
 *   POST /api/v1/cards/<id>/message  `{"text": "..."}`: the person steers the card's running agent
 *   POST /api/v1/cards/<id>/stop-turn  the person takes the wheel: the turn ends, the run waits for their message
 *   POST /api/v1/cards/<id>/hand-back  the run goes on by itself again
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
  /** The card's workpad note (card detail). */
  workpad?: (cardId: string) => Promise<unknown>;
  /** The person moves a card to another column (board buttons). */
  move?: (cardId: string, to: string) => Promise<{ ok: boolean; problem?: string }>;
  /** The person steers a running card from its session (`{"text": "..."}`). */
  steer?: (cardId: string, text: string) => boolean;
  /** Stop from the card's session (take the wheel), and Hand back to Forge. */
  takeWheel?: (cardId: string) => boolean;
  handBack?: (cardId: string) => boolean;
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

/** The `to` column from a small JSON body (`{"to": "Merging"}`); null when it's missing or too big. */
async function readTo(req: IncomingMessage): Promise<string | null> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1024) return null;
  }
  try {
    const to = (JSON.parse(body) as { to?: unknown }).to;
    return typeof to === "string" && to.length > 0 && to.length <= 64 ? to : null;
  } catch {
    return null;
  }
}

/** The `text` of a JSON body up to 64 KB; null when it's missing or too big. */
async function readText(req: IncomingMessage): Promise<string | null> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 65_536) return null;
  }
  try {
    const text = (JSON.parse(body) as { text?: unknown }).text;
    return typeof text === "string" && text.trim() ? text : null;
  } catch {
    return null;
  }
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
      default: {
        const card = /^\/api\/v1\/cards\/([A-Za-z0-9-]{1,64})\/workpad$/.exec(path);
        if (card && deps.workpad) {
          if (req.method !== "GET") return methodNotAllowed(res, "GET");
          return jsonResponse(res, 200, await deps.workpad(card[1]));
        }
        const move = /^\/api\/v1\/cards\/([A-Za-z0-9-]{1,64})\/move$/.exec(path);
        if (move && deps.move) {
          if (!post) return methodNotAllowed(res, "POST");
          const to = await readTo(req);
          if (!to)
            return jsonResponse(res, 400, { ok: false, problem: "Say where the card goes." });
          const result = await deps.move(move[1], to);
          jsonResponse(res, result.ok ? 200 : 409, result);
          return notify();
        }
        const message = /^\/api\/v1\/cards\/([A-Za-z0-9-]{1,64})\/message$/.exec(path);
        if (message && deps.steer) {
          if (!post) return methodNotAllowed(res, "POST");
          const text = await readText(req);
          if (!text)
            return jsonResponse(res, 400, { ok: false, problem: "Write something first." });
          return deps.steer(message[1], text)
            ? jsonResponse(res, 200, { ok: true })
            : jsonResponse(res, 409, {
                ok: false,
                problem: "No agent is working this card right now.",
              });
        }
        const wheel = /^\/api\/v1\/cards\/([A-Za-z0-9-]{1,64})\/(stop-turn|hand-back)$/.exec(path);
        if (wheel && deps.takeWheel && deps.handBack) {
          if (!post) return methodNotAllowed(res, "POST");
          const ok = wheel[2] === "stop-turn" ? deps.takeWheel(wheel[1]) : deps.handBack(wheel[1]);
          return ok
            ? jsonResponse(res, 200, { ok: true })
            : jsonResponse(res, 409, {
                ok: false,
                problem:
                  wheel[2] === "stop-turn"
                    ? "No agent is working this card right now."
                    : "Forge already has this card.",
              });
        }
        return notFound(res);
      }
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
