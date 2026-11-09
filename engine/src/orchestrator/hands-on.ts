/**
 * Forge Desktop: "take the wheel" on a running card. Stop (from the card's session) interrupts the agent's turn and
 * puts the card hands-on: the run keeps the card and its agent, and instead of Forge's own "continue" turn it waits
 * for the person's next message, which becomes the next turn. Hand back clears it and the run carries on by itself.
 * Kept in memory: a restart of the engine ends the run anyway, and the card is dispatched again as usual.
 *
 * New in Forge Desktop.
 */

interface Card {
  wake: ((text: string | null) => void) | null;
}

export class HandsOn {
  private cards = new Map<string, Card>();

  isOn(issueId: string): boolean {
    return this.cards.has(issueId);
  }

  /** The person took the wheel. */
  take(issueId: string): void {
    if (!this.cards.has(issueId)) this.cards.set(issueId, { wake: null });
  }

  /** Back to Forge: a run waiting for the person goes on with its own turn. */
  give(issueId: string): boolean {
    const c = this.cards.get(issueId);
    if (!c) return false;
    this.cards.delete(issueId);
    c.wake?.(null);
    return true;
  }

  /** The person's message while hands-on and between turns: it becomes the next turn. False otherwise. */
  offer(issueId: string, text: string): boolean {
    const c = this.cards.get(issueId);
    if (!c || !c.wake) return false;
    const wake = c.wake;
    c.wake = null;
    wake(text);
    return true;
  }

  /** Waiting between turns for the person (true only while `next` waits). */
  waiting(issueId: string): boolean {
    return this.cards.get(issueId)?.wake != null;
  }

  /**
   * The prompt for the run's next turn: null at once when not hands-on (Forge's own turn), else the person's next
   * message, or null when handed back, stopped or aborted. `alive` is called every `everyMs` while it waits, so the
   * stall check doesn't take a wait for a stuck agent.
   */
  next(
    issueId: string,
    o: {
      signal?: AbortSignal;
      stopping?: () => boolean;
      alive?: () => void;
      everyMs?: number;
    } = {},
  ): Promise<string | null> {
    const c = this.cards.get(issueId);
    if (!c) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setInterval(() => {
        o.alive?.();
        if (o.stopping?.()) done(null);
      }, o.everyMs ?? 1000);
      const onAbort = () => done(null);
      const done = (text: string | null) => {
        clearInterval(timer);
        o.signal?.removeEventListener("abort", onAbort);
        if (c.wake === done) c.wake = null;
        resolve(text);
      };
      if (o.signal?.aborted) return done(null);
      o.signal?.addEventListener("abort", onAbort);
      c.wake = done;
    });
  }

  /** The run ended: nothing to wait for. */
  forget(issueId: string): void {
    const c = this.cards.get(issueId);
    this.cards.delete(issueId);
    c?.wake?.(null);
  }
}
