/**
 * SIGTERM handling for the interactive actor host. With a drain configured, the host refuses
 * new dispatches (the orchestrator retries them on another replica), waits for turns in
 * flight up to `drainMs`, then disposes and exits. Without one it disposes at once and keeps
 * running, which is the legacy interactive app's behaviour.
 */
export interface InteractiveShutdownDrainOptions {
  drainMs: number;
  activeTurnCount: () => number;
  dispose: () => Promise<void>;
  exit: (code: number) => void;
  pollMs?: number;
  log?: (event: Record<string, unknown>) => void;
}

export interface InteractiveShutdownDrain {
  isDraining(): boolean;
  shutdown(signal: string): void;
}

const DEFAULT_POLL_MS = 1_000;

export function createInteractiveShutdownDrain(
  options: InteractiveShutdownDrainOptions,
): InteractiveShutdownDrain {
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const log = options.log ?? ((event) => console.log(JSON.stringify(event)));
  let draining = false;
  let finished = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;

  const finish = (reason: 'idle' | 'deadline' | 'second-signal'): void => {
    if (finished) return;
    finished = true;
    if (pollTimer) clearInterval(pollTimer);
    if (deadlineTimer) clearTimeout(deadlineTimer);
    log({
      event: 'InteractiveHostDrainFinished',
      reason,
      activeTurns: options.activeTurnCount(),
    });
    void options
      .dispose()
      .catch(() => {})
      .finally(() => options.exit(0));
  };

  return {
    isDraining: () => draining,
    shutdown(signal: string): void {
      if (options.drainMs <= 0) {
        void options.dispose().catch(() => {});
        return;
      }
      if (draining) {
        finish('second-signal');
        return;
      }
      draining = true;
      log({
        event: 'InteractiveHostDraining',
        signal,
        drainMs: options.drainMs,
        activeTurns: options.activeTurnCount(),
      });
      if (options.activeTurnCount() === 0) {
        finish('idle');
        return;
      }
      pollTimer = setInterval(() => {
        if (options.activeTurnCount() === 0) finish('idle');
      }, pollMs);
      deadlineTimer = setTimeout(() => finish('deadline'), options.drainMs);
    },
  };
}
