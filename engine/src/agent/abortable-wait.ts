/**
 * Settle `pending`, but reject once `deadline` (epoch ms) passes or `signal`
 * aborts — whichever comes first. `what` completes the error message
 * (e.g. "waiting for response id=1"). `pending` itself is left running.
 */
export async function settleBefore<T>(
  pending: Promise<T>,
  deadline: number,
  what: string,
  signal?: AbortSignal,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        const timeout = new Error(`Timed out ${what}`);
        timer = setTimeout(() => reject(timeout), Math.max(0, deadline - Date.now()));
        onAbort = () => reject(new Error(`Aborted ${what}`, { cause: signal?.reason }));
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}
