/**
 * Detects a resident loop that is still scheduled but no longer making
 * progress — the process looks alive to the platform, so nothing restarts it.
 */
import { flushTelemetry, trackEvent } from '../services/telemetry';
import { exitAfterFlush } from './processExit';

export interface StalledLoop {
  name: string;
  overdueMs: number;
}

export interface ProgressWatchdog {
  /** Records progress for `name`; the next beat must arrive within `nextWithinMs`. */
  beat(name: string, nextWithinMs: number): void;
  /** Stops watching `name`, for a loop that ended on purpose. */
  clear(name: string): void;
  stalled(): StalledLoop[];
}

export const DEFAULT_WATCHDOG_POLL_MS = 15_000;

export function createProgressWatchdog(now: () => number = Date.now): ProgressWatchdog {
  const dueAt = new Map<string, number>();
  return {
    beat(name, nextWithinMs) {
      dueAt.set(name, now() + Math.max(1, nextWithinMs));
    },
    clear(name) {
      dueAt.delete(name);
    },
    stalled() {
      const current = now();
      const result: StalledLoop[] = [];
      for (const [name, due] of dueAt) {
        if (current > due) result.push({ name, overdueMs: current - due });
      }
      return result;
    },
  };
}

export interface ExitWhenStalledOptions {
  pollMs?: number;
  exit?: (code: number) => void;
  schedule?: (callback: () => void, ms: number) => { unref?: () => void };
}

/**
 * Polls the watchdog and exits the process the first time a loop is overdue,
 * so Container Apps replaces the replica. Only for services whose platform
 * restarts a container that exits; returns a function that stops polling.
 */
export function exitWhenStalled(
  service: string,
  watchdog: ProgressWatchdog,
  options: ExitWhenStalledOptions = {},
): () => void {
  const pollMs = options.pollMs ?? DEFAULT_WATCHDOG_POLL_MS;
  let exiting = false;
  const timer = setInterval(() => {
    if (exiting) return;
    const stalled = watchdog.stalled();
    if (stalled.length === 0) return;
    exiting = true;
    clearInterval(timer);
    const loops = stalled.map((loop) => loop.name).join(',');
    const maxOverdueMs = Math.max(...stalled.map((loop) => loop.overdueMs));
    console.error(JSON.stringify({ event: 'ServiceStalled', service, loops, maxOverdueMs }));
    trackEvent('service.stalled', { service, loops }, { maxOverdueMs });
    void exitAfterFlush(1, {
      flush: () => flushTelemetry(),
      ...(options.exit ? { exit: options.exit } : {}),
      ...(options.schedule ? { schedule: options.schedule } : {}),
    });
  }, pollMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
