/**
 * Pictures in a message (pasted or dropped on the message box), and long pastes the app turned into .txt files. The host keeps each one as a file beside the chat's
 * history and the message carries one `[image: <path>]` line per picture, so the outbox, the transcript and a restart
 * all handle a message as plain text. When the message reaches Claude Code those lines become image blocks.
 *
 * New in Forge Desktop.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

export const IMAGE_LINE = /^\[image: (.+\.(png|jpe?g|gif|webp))\]$/i;
/** A long paste kept as a .txt file beside the chat (the app attaches pastes over 4,000 characters). */
export const TEXT_LINE = /^\[text: (.+\.txt)\]$/;
const TYPES: Record<string, string> = {
  png: "png",
  jpeg: "jpg",
  jpg: "jpg",
  gif: "gif",
  webp: "webp",
};
/** Claude's own limit per picture is 5 MB. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export interface ImageIn {
  mediaType: string;
  data: string;
}

/** Saves the pictures under `<home>/attachments/<chat>/` and returns the message with one line per picture. */
export function attachImages(
  home: string,
  chatId: string,
  text: string,
  images: ImageIn[],
): string {
  if (images.length === 0) return text;
  const dir = join(home, "attachments", chatId.replace(/[^\w-]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const lines: string[] = [];
  for (const img of images) {
    const ext = TYPES[img.mediaType.replace(/^image\//, "").toLowerCase()];
    if (!ext) continue;
    const bytes = Buffer.from(img.data, "base64");
    if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) continue;
    const path = join(dir, `${randomUUID()}.${ext}`);
    writeFileSync(path, bytes);
    lines.push(`[image: ${path}]`);
  }
  return [text.trimEnd(), ...lines].filter(Boolean).join("\n");
}

/** Saves long pastes as `<home>/attachments/<chat>/<id>-<name>.txt`; the message carries one `[text: <path>]` line each. */
export function attachTexts(
  home: string,
  chatId: string,
  text: string,
  texts: { name: string; text: string }[],
): string {
  const kept = texts.filter((t) => t.text.length > 0);
  if (kept.length === 0) return text;
  const dir = join(home, "attachments", chatId.replace(/[^\w-]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const lines = kept.map((t) => {
    const name = (t.name || "Pasted text.txt")
      .replace(/[^\w .-]/g, "-")
      .replace(/(\.txt)?$/, ".txt");
    const path = join(dir, `${randomUUID().slice(0, 8)}-${name}`);
    writeFileSync(path, t.text);
    return `[text: ${path}]`;
  });
  return [text.trimEnd(), ...lines].filter(Boolean).join("\n");
}

/**
 * What Claude Code gets: the text as is, or blocks when the message has pictures (image blocks) or long pastes (a
 * text block each, with the whole paste, so the agent reads it without a tool call).
 */
export function claudeContent(text: string): string | Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];
  const rest: string[] = [];
  for (const line of text.split("\n")) {
    const t = TEXT_LINE.exec(line.trim());
    if (t?.[1] && existsSync(t[1])) {
      const body = readFileSync(t[1], "utf-8");
      const name = basename(t[1]).replace(/^[0-9a-f]{8}-/, "");
      blocks.push({
        type: "text",
        text: `${name} (${body.length.toLocaleString("en-US")} characters):\n\n${body}`,
      });
      continue;
    }
    const m = IMAGE_LINE.exec(line.trim());
    if (!m?.[1] || !existsSync(m[1])) {
      rest.push(line);
      continue;
    }
    const ext = (m[2] ?? "png").toLowerCase();
    blocks.push({
      type: "image",
      source: {
        type: "base64",
        media_type: `image/${ext === "jpg" ? "jpeg" : ext}`,
        data: readFileSync(m[1]).toString("base64"),
      },
    });
  }
  if (blocks.length === 0) return text;
  const words = rest.join("\n").trim();
  return words ? [...blocks, { type: "text", text: words }] : blocks;
}
