/**
 * Env-var names whose runtime VALUES are secrets (FRG-2075, BYOK T11): the
 * `envNames` of `secret-spec.json` plus every provider `keyEnvVar` from
 * `src/config/providers.ts`. The Python side (`scripts/secret_spec.py`) builds
 * the same set from the same JSON and `scripts/provider_registry.py`, so the
 * log redactor, the build-report scrub, the worker env split and the stamp
 * scanner can never disagree on what counts as a secret (FRG-2082).
 */

import { secretValueEnvNames } from "./secret-spec.js";

export const SECRET_VALUE_ENV_NAMES: readonly string[] = secretValueEnvNames();
