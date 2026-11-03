/**
 * Simple in-memory metrics collector for observability.
 */
export class MetricsCollector {
  private tokensBySession = new Map<string, { input: number; output: number }>();
  private sessionDurations = new Map<string, number>();
  private retryCounts = new Map<string, number>();
  private _activeWorkers = 0;

  recordTokens(sessionId: string, input: number, output: number): void {
    const existing = this.tokensBySession.get(sessionId) ?? {
      input: 0,
      output: 0,
    };
    this.tokensBySession.set(sessionId, {
      input: existing.input + input,
      output: existing.output + output,
    });
  }

  recordSessionDuration(sessionId: string, durationMs: number): void {
    this.sessionDurations.set(sessionId, durationMs);
  }

  incrementRetryCount(issueId: string): void {
    const current = this.retryCounts.get(issueId) ?? 0;
    this.retryCounts.set(issueId, current + 1);
  }

  setActiveWorkers(count: number): void {
    this._activeWorkers = count;
  }

  getSnapshot(): {
    activeWorkers: number;
    totalTokens: { input: number; output: number };
    sessionCount: number;
    tokensBySession: Map<string, { input: number; output: number }>;
    sessionDurations: Map<string, number>;
    retryCounts: Map<string, number>;
  } {
    let totalInput = 0;
    let totalOutput = 0;
    for (const t of this.tokensBySession.values()) {
      totalInput += t.input;
      totalOutput += t.output;
    }

    return {
      activeWorkers: this._activeWorkers,
      totalTokens: { input: totalInput, output: totalOutput },
      sessionCount: this.tokensBySession.size,
      tokensBySession: new Map(this.tokensBySession),
      sessionDurations: new Map(this.sessionDurations),
      retryCounts: new Map(this.retryCounts),
    };
  }

  reset(): void {
    this.tokensBySession.clear();
    this.sessionDurations.clear();
    this.retryCounts.clear();
    this._activeWorkers = 0;
  }
}
