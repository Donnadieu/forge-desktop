import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowStore } from "../../../src/config/watcher.js";

describe("WorkflowStore", () => {
  let tempDir: string;
  let store: WorkflowStore | null = null;

  function createTempDir(): string {
    const dir = join(
      tmpdir(),
      `forge-watcher-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  function writeWorkflow(dir: string, content: string): string {
    const filePath = join(dir, "WORKFLOW.md");
    writeFileSync(filePath, content);
    return filePath;
  }

  afterEach(() => {
    if (store) {
      store.close();
      store = null;
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("loads config on first call to current()", () => {
    tempDir = createTempDir();
    const filePath = writeWorkflow(
      tempDir,
      `---
tracker:
  kind: linear
  project_slug: test-project
  active_states: [Todo]
---
Fix {{ issue.identifier }}`,
    );

    store = new WorkflowStore(filePath);
    const { config, promptTemplate } = store.current();

    expect(config.tracker.kind).toBe("linear");
    expect(config.tracker.project_slug).toBe("test-project");
    expect(promptTemplate).toBe("Fix {{ issue.identifier }}");
  });

  it("returns cached config on subsequent calls", () => {
    tempDir = createTempDir();
    const filePath = writeWorkflow(
      tempDir,
      `---
tracker:
  kind: linear
  project_slug: cached
  active_states: [Todo]
---
prompt`,
    );

    store = new WorkflowStore(filePath);
    const first = store.current();
    const second = store.current();

    expect(first.config).toBe(second.config); // Same reference = cached
  });

  it("forceReload() re-reads the file", () => {
    tempDir = createTempDir();
    const filePath = writeWorkflow(
      tempDir,
      `---
tracker:
  kind: linear
  project_slug: original
  active_states: [Todo]
---
prompt1`,
    );

    store = new WorkflowStore(filePath);
    store.current();

    writeFileSync(
      filePath,
      `---
tracker:
  kind: linear
  project_slug: updated
  active_states: [Todo]
---
prompt2`,
    );

    const result = store.forceReload();
    expect(result.config.tracker.project_slug).toBe("updated");
    expect(result.promptTemplate).toBe("prompt2");
  });

  it("emits change events when watching and file changes", async () => {
    tempDir = createTempDir();
    const filePath = writeWorkflow(
      tempDir,
      `---
tracker:
  kind: linear
  project_slug: original
  active_states: [Todo]
---
prompt`,
    );

    store = new WorkflowStore(filePath, { debounceMs: 10 });

    const changes: string[] = [];
    store.on("change", (data) => {
      changes.push(data.config.tracker.project_slug);
    });
    store.watch();

    // Wait for watcher to stabilize
    await new Promise((r) => setTimeout(r, 50));

    // Modify the file
    writeFileSync(
      filePath,
      `---
tracker:
  kind: linear
  project_slug: changed
  active_states: [Todo]
---
new prompt`,
    );

    // Wait for debounced change event
    await new Promise((r) => setTimeout(r, 200));

    expect(changes).toContain("changed");
  });

  it("close() stops watching", () => {
    tempDir = createTempDir();
    const filePath = writeWorkflow(
      tempDir,
      `---
tracker:
  kind: linear
  project_slug: test
  active_states: [Todo]
---
prompt`,
    );

    store = new WorkflowStore(filePath);
    store.watch();
    store.close();

    // Should not throw
    expect(() => store?.close()).not.toThrow();
  });

  it("watch() is idempotent", () => {
    tempDir = createTempDir();
    const filePath = writeWorkflow(
      tempDir,
      `---
tracker:
  kind: linear
  project_slug: test
  active_states: [Todo]
---
prompt`,
    );

    store = new WorkflowStore(filePath);
    store.watch();
    store.watch(); // Second call should be no-op

    store.close();
  });
});
