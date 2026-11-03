/**
 * Strip any provider prefix from a model id: the text after the last `/`
 * (`"openai/o3"` → `"o3"`, `"openrouter/anthropic/claude-opus-4-8"` →
 * `"claude-opus-4-8"`). An unprefixed id is returned unchanged.
 *
 * A dependency-free leaf: `agent/`, `db/` and `mcp/` import this file directly,
 * not the `config/` barrel.
 */
export function bareModelId(model: string): string {
  return model.slice(model.lastIndexOf("/") + 1);
}
