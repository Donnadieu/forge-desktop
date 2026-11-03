/**
 * Loader for the one cross-language definition of a secret (FRG-2082):
 * `secret-spec.json`, also loaded by `scripts/secret_spec.py`. Edit the JSON,
 * never a hand-written list here. Provider key env vars come from the provider
 * registry (`PROVIDER_KEY_VARS`), so a new provider is redacted automatically.
 * The JSON is read next to this module, so the `build` script copies it into
 * `dist/` (the Smith orchestrator tarball ships `dist/` alone).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { PROVIDER_KEY_VARS } from "../config/providers.js";

const PatternSchema = z.object({ label: z.string().min(1), regex: z.string().min(1) });

const SecretSpecSchema = z.object({
  placeholder: z.string().min(1),
  minValueLength: z.number().int().positive(),
  envNames: z.array(z.string().min(1)),
  redactPatterns: z.array(PatternSchema).min(1),
  scanPatterns: z.array(PatternSchema).min(1),
});

export type SecretSpec = z.infer<typeof SecretSpecSchema>;

export const SECRET_SPEC_PATH = fileURLToPath(new URL("./secret-spec.json", import.meta.url));

export const SECRET_SPEC: SecretSpec = SecretSpecSchema.parse(
  JSON.parse(readFileSync(SECRET_SPEC_PATH, "utf-8")),
);

/** The spec's env names plus every provider key env var, deduplicated, spec order first. */
export function secretValueEnvNames(spec: SecretSpec = SECRET_SPEC): string[] {
  const providerKeys = Object.values(PROVIDER_KEY_VARS).filter((v): v is string => !!v);
  return [...new Set([...spec.envNames, ...providerKeys])];
}
