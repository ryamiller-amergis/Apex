/**
 * Overlap guard for scheduled background work. A plain `isRunning` flag stays
 * set forever if one run hangs, silently stopping the job; this guard lets the
 * next run start once the previous one has been in flight past `stuckAfterMs`.
 * The hung run is abandoned, not cancelled, so the work must tolerate a late
 * finisher (every scheduled job here is idempotent per pass).
 */
export interface SingleFlight {
  /** Returns a token to pass to `exit`, or null when a run is in flight and not yet stuck. */
  tryEnter(): number | null;
  exit(token: number): void;
  /** Runs `work` under `tryEnter`/`exit`; returns false when skipped. */
  run(work: () => Promise<unknown>): Promise<boolean>;
  isRunning(): boolean;
}

export interface SingleFlightOptions {
  name: string;
  stuckAfterMs: number;
  now?: () => number;
  log?: (message: string) => void;
}

/** Twice the interval, never under 30 minutes: long enough that a slow pass is not mistaken for a hung one. */
export function stuckAfterForInterval(intervalMs: number): number {
  return Math.max(2 * intervalMs, 30 * 60_000);
}

export function createSingleFlight(options: SingleFlightOptions): SingleFlight {
  const now = options.now ?? Date.now;
  const log = options.log ?? ((message: string) => console.warn(message));
  let generation = 0;
  let activeGeneration: number | null = null;
  let startedAt = 0;

  const guard: SingleFlight = {
    tryEnter() {
      if (activeGeneration !== null) {
        const inFlightMs = now() - startedAt;
        if (inFlightMs < options.stuckAfterMs) return null;
        log(`[${options.name}] previous run stuck for ${inFlightMs}ms; starting a new run`);
      }
      generation += 1;
      activeGeneration = generation;
      startedAt = now();
      return generation;
    },
    exit(token) {
      if (activeGeneration === token) activeGeneration = null;
    },
    async run(work) {
      const token = guard.tryEnter();
      if (token === null) return false;
      try {
        await work();
        return true;
      } finally {
        guard.exit(token);
      }
    },
    isRunning() {
      return activeGeneration !== null;
    },
  };
  return guard;
}
