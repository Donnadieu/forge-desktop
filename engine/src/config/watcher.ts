import { type FSWatcher, watch } from "node:fs";
import { parseWorkflowFile } from "./loader.js";
import { resolveConfig } from "./resolver.js";
import type { WorkflowConfig } from "./schema.js";

type ChangeListener = (data: { config: WorkflowConfig; promptTemplate: string }) => void;

/**
 * Watches a WORKFLOW.md file for changes and re-parses on change.
 * Also provides synchronous access to the cached config via current().
 */
export class WorkflowStore {
  private filePath: string;
  private cachedConfig: WorkflowConfig | null = null;
  private cachedPromptTemplate: string = "";
  private watcher: FSWatcher | null = null;
  private listeners: ChangeListener[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private debounceMs: number;

  constructor(filePath: string, opts?: { debounceMs?: number }) {
    this.filePath = filePath;
    this.debounceMs = opts?.debounceMs ?? 100;
  }

  /**
   * Get the current config, loading from disk on first call.
   */
  current(): { config: WorkflowConfig; promptTemplate: string } {
    if (!this.cachedConfig) {
      return this.forceReload();
    }
    return {
      config: this.cachedConfig,
      promptTemplate: this.cachedPromptTemplate,
    };
  }

  /**
   * Force a reload from disk, updating the cache.
   */
  forceReload(): { config: WorkflowConfig; promptTemplate: string } {
    const parsed = parseWorkflowFile(this.filePath);
    this.cachedConfig = resolveConfig(parsed.config);
    this.cachedPromptTemplate = parsed.promptTemplate;
    return {
      config: this.cachedConfig,
      promptTemplate: this.cachedPromptTemplate,
    };
  }

  /**
   * Register a listener for config changes.
   */
  on(_event: "change", listener: ChangeListener): this {
    this.listeners.push(listener);
    return this;
  }

  /**
   * Start watching the file for changes using fs.watch.
   */
  watch(): this {
    if (this.watcher) return this;

    // Ensure we have an initial load
    if (!this.cachedConfig) {
      this.forceReload();
    }

    this.watcher = watch(this.filePath, () => {
      // Debounce rapid changes (editors often fire multiple events)
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
      }
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null;
        try {
          const result = this.forceReload();
          for (const listener of this.listeners) {
            listener(result);
          }
        } catch {
          // File may be mid-write; ignore and wait for next event
        }
      }, this.debounceMs);
    });

    return this;
  }

  /**
   * Stop watching and clean up.
   */
  close(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    this.listeners = [];
  }
}
