/** Warn when agent kind and model are likely incompatible. */
export function checkAgentModelCompat(kind: string, model: string | undefined): void {
  if (!model) return;
  const m = model.toLowerCase();
  let warning: string | null = null;
  if (
    kind === "codex" &&
    !m.includes("gpt") &&
    !m.includes("codex") &&
    !m.includes("o1") &&
    !m.includes("o3") &&
    !m.includes("o4")
  ) {
    warning = `Agent "codex" may not support model "${model}" — Codex requires OpenAI models`;
  }
  if (kind === "claude" && (m.includes("gpt") || m.includes("codex"))) {
    warning = `Agent "claude" may not support model "${model}" — Claude Code expects Anthropic models`;
  }
  if (kind === "kimi" && !m.includes("kimi") && !m.includes("moonshot")) {
    warning = `Agent "kimi" may not support model "${model}" — Kimi CLI expects Kimi/Moonshot models`;
  }
  if (warning) process.stderr.write(`[WARN] ${warning}\n`);
}
