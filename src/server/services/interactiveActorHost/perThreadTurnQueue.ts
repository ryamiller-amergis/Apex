/**
 * FEAT-007 / TBI-010 — per-thread turn serialization (BR-015).
 *
 * A Dapr virtual actor keyed by `threadId` already provides single activation +
 * turn-based concurrency. This queue makes that invariant explicit and testable
 * inside the host: for a given `threadId` at most ONE turn is in flight and
 * turns run in submission order (FIFO). Different threads run concurrently.
 *
 * The queue owns ordering only — it never inspects turn payloads, so no prompt
 * or snapshot content is retained here (BR-019).
 */
export interface PerThreadTurnQueue {
  /**
   * Enqueue a turn for `threadId`. Resolves with the turn's result once all
   * previously-enqueued turns for the same thread have settled and this turn
   * has run. Rejections are isolated per turn and never block the next turn.
   */
  submit<T>(threadId: string, turn: () => Promise<T>): Promise<T>;
  /** Number of threads with a pending/in-flight tail (diagnostics/telemetry). */
  activeThreadCount(): number;
}

export function createPerThreadTurnQueue(): PerThreadTurnQueue {
  // tails[threadId] is the promise chain for that thread; a new turn always
  // chains after the current tail, guaranteeing one-in-flight + FIFO order.
  const tails = new Map<string, Promise<unknown>>();

  return {
    submit<T>(threadId: string, turn: () => Promise<T>): Promise<T> {
      const previous = tails.get(threadId) ?? Promise.resolve();
      // Run this turn only after the previous one settles (success OR failure),
      // so a failed turn cannot stall the thread's subsequent turns.
      const result = previous.then(
        () => turn(),
        () => turn(),
      );

      // Advance the tail; swallow rejection on the chain used purely for
      // ordering so an unhandled rejection is never emitted by the queue.
      const tail = result.then(
        () => undefined,
        () => undefined,
      );
      tails.set(threadId, tail);

      // Evict the thread's entry once it drains to bound memory across many
      // short-lived threads.
      void tail.then(() => {
        if (tails.get(threadId) === tail) tails.delete(threadId);
      });

      return result;
    },
    activeThreadCount(): number {
      return tails.size;
    },
  };
}
