# Tech debt

The lint baseline (`tools/lint/baseline.json`) is empty. Debt that a rule can't see goes here, and
the list only shrinks.

| Debt | Why it exists | Pay it down by |
|---|---|---|
| Secrets-only-in-Keychain has no enforcer | nothing reads secrets yet | a lint rule with the first Keychain code (setup screen 1) |
| The lead-waits-for-helpers rule has no enforcer | the engine isn't imported yet | an engine test with the worker change |
