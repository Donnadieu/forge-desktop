/**
 * The sessions host's local API. Same rules as the board engine's (server/local-api.ts): 127.0.0.1 on a port
 * the OS picks, every request carries the launch token, and changes reach the app over one WebSocket.
 *
 *   GET  /api/v1/sessions                        every session with its chats and status
 *   POST /api/v1/sessions                        new session: repo, base, first message, model, effort; a typed or existing branch
 *   POST /api/v1/sessions/branches               the branches a new session can open (repo, local, base)
 *   POST /api/v1/sessions/<id>/chats             another chat in the session
 *   POST /api/v1/sessions/<id>/read              mark it read
 *   GET  /api/v1/sessions/<id>/changes           files changed against the base branch
 *   GET  /api/v1/sessions/<id>/diff?path=        one file's diff
 *   GET  /api/v1/sessions/<id>/pr                its pull request (refreshed from GitHub)
 *   GET  /api/v1/sessions/<id>/review-comments   the pull request's review threads
 *   POST /api/v1/sessions/<id>/merge | archive | unarchive | update | ready | publish
 *   POST /api/v1/sessions/<id>/rename            {branch}: renames the branch here and on GitHub
 *   GET  /api/v1/chats/<id>/turns?before=&limit= turns with their events, newest last
 *   POST /api/v1/chats/<id>/messages             {text, mode: steer | queue, images: [{mediaType, data}]}
 *   POST /api/v1/chats/<id>/stop | answer | settings (model, effort, title, planMode, askBeforeChanges, hidden) | revert
 *   POST /api/v1/cards/watch                     {cards: [...]}: the cards running now, followed as card sessions
 *   GET  /api/v1/conductor                       what an import from Conductor would bring; ?repo=owner/name: that repo only
 *   POST /api/v1/conductor/import                {ids: [Conductor workspace id], workspace}
 *   WS   /api/v1/live                            session, chat, turn and event changes
 *
 * New in Forge Desktop.
 */
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Logger } from "pino";
import { WebSocket, WebSocketServer } from "ws";
import { jsonResponse, notFound, readJsonBody } from "../server/http-utils.js";
import { attachImages } from "./attachments.js";
import { previewImport, runImport } from "./conductor.js";
import type { SessionsHost } from "./host.js";
import type { SessionStore } from "./store.js";

function tokenMatches(header: string | undefined, token: string): boolean {
  const given = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

type Body = Record<string, unknown>;

async function body(req: IncomingMessage): Promise<Body> {
  try {
    // Room for a few pasted pictures (base64) in one message.
    return (await readJsonBody(req, 24 * 1024 * 1024)) as Body;
  } catch {
    return {};
  }
}

const s = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);

export interface SessionsApi {
  port: number;
  broadcast: (frame: Record<string, unknown>) => void;
  close: () => Promise<void>;
}

export async function startSessionsApi(deps: {
  token: string;
  host: () => SessionsHost;
  store: SessionStore;
  logger?: Logger;
}): Promise<SessionsApi> {
  if (deps.token.length < 32) throw new Error("the launch token must be at least 32 characters");
  const wss = new WebSocketServer({ noServer: true });
  const broadcast = (frame: Record<string, unknown>): void => {
    const text = JSON.stringify(frame);
    for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(text);
  };

  const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!tokenMatches(req.headers.authorization, deps.token))
      return jsonResponse(res, 401, { error: "unauthorized" });
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    const post = req.method === "POST";
    const h = deps.host();
    if (path === "/api/v1/sessions") {
      if (!post) return jsonResponse(res, 200, { sessions: h.list() });
      const b = await body(req);
      const r = await h.create({
        workspaceId: s(b.workspaceId, "default"),
        repo: s(b.repo),
        local: s(b.local) || null,
        base: s(b.base, "main"),
        prefix: s(b.prefix),
        message: s(b.message),
        model: s(b.model, "opus[1m]"),
        effort: s(b.effort, "high"),
        title: s(b.title) || undefined,
        branch: s(b.branch) || undefined,
        existing: b.existing === true,
      });
      return jsonResponse(res, r.ok ? 200 : 409, r);
    }
    if (path === "/api/v1/sessions/branches" && post) {
      const b = await body(req);
      const list = await h.branches(s(b.repo), s(b.local) || null, s(b.base, "main"));
      return jsonResponse(res, 200, { branches: list });
    }
    if (path === "/api/v1/conductor") {
      const repo = url.searchParams.get("repo") || undefined;
      return jsonResponse(res, 200, previewImport(deps.store, undefined, repo));
    }
    if (path === "/api/v1/conductor/import" && post) {
      const b = await body(req);
      const ids = Array.isArray(b.ids) ? (b.ids as unknown[]).map(String) : [];
      const r = runImport(deps.store, { ids, workspace: s(b.workspace, "default") });
      broadcast({ type: "sessions", sessions: h.list() });
      return jsonResponse(res, 200, { ok: true, ...r });
    }
    if (path === "/api/v1/cards/watch" && post) {
      const b = await body(req);
      const cards = Array.isArray(b.cards) ? (b.cards as Body[]) : [];
      const ids = h.cards.watch(
        cards
          .filter((c) => s(c.key) && s(c.folder) && s(c.sessionId))
          .map((c) => ({
            key: s(c.key),
            workspaceId: s(c.workspaceId, "default"),
            identifier: s(c.identifier),
            title: s(c.title),
            folder: s(c.folder),
            sessionId: s(c.sessionId),
            branch: s(c.branch),
            repo: s(c.repo),
            model: s(c.model, "opus"),
          })),
      );
      return jsonResponse(res, 200, { ok: true, sessions: ids });
    }
    const sm = /^\/api\/v1\/sessions\/([\w-]{1,80})\/([a-z-]+)$/.exec(path);
    if (sm) {
      const [, id, action] = sm;
      switch (action) {
        case "chats": {
          const b = await body(req);
          const c = h.newChat(id, s(b.model, "opus[1m]"), s(b.effort, "high"), s(b.title, "Chat"));
          if (s(b.message)) await h.chats.send(c.id, s(b.message), "steer");
          return jsonResponse(res, 200, { ok: true, chat: c });
        }
        case "read":
          await h.markRead(id);
          return jsonResponse(res, 200, { ok: true });
        case "changes":
          return jsonResponse(res, 200, await h.changes(id));
        case "diff":
          return jsonResponse(res, 200, await h.diff(id, url.searchParams.get("path") ?? ""));
        case "pr":
          return jsonResponse(res, 200, await h.pr(id));
        case "review-comments":
          return jsonResponse(res, 200, await h.reviewComments(id));
        case "merge":
          return jsonResponse(res, 200, await h.merge(id));
        case "archive":
          return jsonResponse(res, 200, await h.archive(id));
        case "update":
          return jsonResponse(res, 200, await h.update(id));
        case "ready":
          return jsonResponse(res, 200, await h.ready(id));
        case "publish":
          return jsonResponse(res, 200, await h.publish(id));
        case "rename": {
          const b = await body(req);
          return jsonResponse(res, 200, await h.rename(id, s(b.branch)));
        }
        case "unarchive": {
          const b = await body(req);
          return jsonResponse(res, 200, await h.unarchive(id, s(b.local) || null));
        }
      }
    }
    const cm = /^\/api\/v1\/chats\/([\w-]{1,80})\/([a-z]+)$/.exec(path);
    if (cm) {
      const [, id, action] = cm;
      switch (action) {
        case "turns": {
          const before = url.searchParams.get("before");
          const limit = Math.min(200, Number(url.searchParams.get("limit") ?? 50) || 50);
          return jsonResponse(res, 200, {
            turns: deps.store.turns(id, before ? Number(before) : null, limit),
            total: deps.store.turnCount(id),
          });
        }
        case "messages": {
          const b = await body(req);
          const images = Array.isArray(b.images)
            ? (b.images as Body[]).map((i) => ({ mediaType: s(i.mediaType), data: s(i.data) }))
            : [];
          if (!s(b.text).trim() && images.length === 0)
            return jsonResponse(res, 400, { ok: false, problem: "Write something first." });
          if (id.startsWith("card-"))
            return jsonResponse(res, 409, {
              ok: false,
              problem: "A card's agent takes messages through its own engine.",
            });
          const text = attachImages(h.home, id, s(b.text), images);
          await h.chats.send(id, text, b.mode === "queue" ? "queue" : "steer");
          return jsonResponse(res, 200, { ok: true });
        }
        case "stop":
          h.chats.stop(id);
          return jsonResponse(res, 200, { ok: true });
        case "answer": {
          const b = await body(req);
          const r = await h.chats.answer(id, s(b.eventId), {
            allow: b.allow !== false,
            answers: b.answers as Record<string, string> | undefined,
            feedback: s(b.feedback) || undefined,
          });
          return jsonResponse(res, r.ok ? 200 : 409, r);
        }
        case "settings": {
          const b = await body(req);
          const p: Record<string, unknown> = {};
          for (const k of ["model", "effort", "title"]) if (typeof b[k] === "string") p[k] = b[k];
          for (const k of ["planMode", "askBeforeChanges", "hidden"])
            if (typeof b[k] === "boolean") p[k] = b[k];
          await h.chats.change(id, p);
          return jsonResponse(res, 200, { ok: true });
        }
        case "revert": {
          const b = await body(req);
          const r = await h.revert(id, s(b.turnId));
          return jsonResponse(res, r.ok ? 200 : 409, r);
        }
      }
    }
    return notFound(res);
  };

  const server = createServer((req, res) => {
    route(req, res).catch((err) => {
      deps.logger?.error({ err }, "sessions API request failed");
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
      ws.send(JSON.stringify({ type: "sessions", sessions: deps.host().list() }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  return {
    port: (server.address() as AddressInfo).port,
    broadcast,
    close: async () => {
      for (const c of wss.clients) c.terminate();
      wss.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
