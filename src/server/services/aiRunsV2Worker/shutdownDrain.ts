/**
 * How long a run in flight may keep going after SIGTERM. Unset means abort at once. Must stay
 * below the replica's termination grace period, or the platform kills the run before it can
 * publish a terminal result.
 */
export function resolveShutdownDrainMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 0;
  const drainMs = Number(raw);
  if (!Number.isSafeInteger(drainMs) || drainMs < 0) {
    throw new Error(
      `AI_RUNS_V2_SHUTDOWN_DRAIN_MS must be a non-negative integer, got "${raw}"`
    );
  }
  return drainMs;
}

export type ShutdownController = {
  /** Stops the receive loop. */
  receiveSignal: AbortSignal;
  /** Aborts the run in flight. */
  executionSignal: AbortSignal;
  shutdown(): void;
};

export function createShutdownController(drainMs: number): ShutdownController {
  const stopReceiving = new AbortController();
  const stopExecution = new AbortController();
  let drainTimer: ReturnType<typeof setTimeout> | null = null;
  return {
    receiveSignal: stopReceiving.signal,
    executionSignal: stopExecution.signal,
    shutdown() {
      // A second signal while draining aborts the run in flight.
      if (stopReceiving.signal.aborted || drainMs === 0) {
        if (drainTimer) clearTimeout(drainTimer);
        stopReceiving.abort();
        stopExecution.abort();
        return;
      }
      stopReceiving.abort();
      drainTimer = setTimeout(() => stopExecution.abort(), drainMs);
      drainTimer.unref();
    },
  };
}
