# QA Plan — <Feature name> (<PR / branch ref>)

<!--
Output template for a QA plan. Replace every <…> placeholder and delete the
HTML comments. Keep the plan self-contained.
-->

**Change:** <one-paragraph plain description of the behavior under test and why it
changed — include the regression the fix addresses, if any>.

## What we're verifying

- **Observation surface:** <where the effect becomes visible — a page of the app,
  a command's output, a file, an API response, a database row, a log line.
  Say exactly where to look.>
- **Trigger:** <the real action that produces the effect — a UI click/submit, the
  command, an HTTP call, or (last resort, say so) a console/DB step.>

---

## Environment

- How the app was started: <the exact commands, from the repo's README or scripts>
- Where it runs: <URL and port, or the command to run>
- Data: <the local database or files it uses, if any>

<!-- If the surface is non-browser, add exactly where to watch, e.g. a specific
query, a log file, or the command's output. -->

## Fixtures

| Purpose | Identifier | Key state |
|---|---|---|
| <e.g. a test user> | <email / id> | <what state it must be in> |

<!-- List the exact fixtures + their state; all setup is additive. -->

## Scenarios

### 1. <Scenario name — the happy path / the regression>
- **Trigger:** <exact action>
- **Expected:** <exact, checkable result on the surface>

### 2. <Scenario name — a branch/fallback>
- **Trigger:** <…>
- **Expected:** <…>

<!-- Add one section per scenario. Cover the happy path, each branch/fallback, the
"does nothing" cases, and the regression the fix targets. -->

## Caveats
- Confirm URLs/state from the **visible UI and address bar**, not scripted reads.
- <Any change-specific caveat.>
