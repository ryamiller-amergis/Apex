/**
 * Hourly single-instance Journey rollup scheduler (TBI-010 / FEAT-008).
 * Failures are isolated from capture and user-request processing.
 */
import {
  JOURNEY_ROLLUP_INTERVAL_MS,
  JOURNEY_ROLLUP_STARTUP_DELAY_MS,
  createJourneyAggregationService,
  type JourneyAggregationCycleResult,
} from './journeyAggregationService';
import { trackEvent } from './telemetry';

export { JOURNEY_ROLLUP_INTERVAL_MS, JOURNEY_ROLLUP_STARTUP_DELAY_MS };

export interface JourneyAggregationSchedulerDeps {
  runCycle?: () => Promise<JourneyAggregationCycleResult>;
  now?: () => Date;
  intervalMs?: number;
  startupDelayMs?: number;
  track?: typeof trackEvent;
}

export interface JourneyAggregationScheduler {
  start(options?: { e2eMode?: boolean }): void;
  stop(): void;
  tick(): Promise<void>;
}

export function createJourneyAggregationScheduler(
  deps: JourneyAggregationSchedulerDeps = {},
): JourneyAggregationScheduler {
  const runCycle = deps.runCycle ?? (() => createJourneyAggregationService().runJourneyAggregationCycle());
  const intervalMs = deps.intervalMs ?? JOURNEY_ROLLUP_INTERVAL_MS;
  const startupDelayMs = deps.startupDelayMs ?? JOURNEY_ROLLUP_STARTUP_DELAY_MS;
  const track = deps.track ?? trackEvent;

  let intervalTimer: ReturnType<typeof setInterval> | null = null;
  let startupTimer: ReturnType<typeof setTimeout> | null = null;
  let isRunning = false;

  async function tick(): Promise<void> {
    if (isRunning) return;
    isRunning = true;
    const startedAt = (deps.now ?? (() => new Date()))().getTime();
    try {
      await runCycle();
    } catch (err) {
      const durationMs = Math.max(0, (deps.now ?? (() => new Date()))().getTime() - startedAt);
      const message = err instanceof Error ? err.message : 'unknown';
      try {
        console.error(`[journey-rollup] cycle failed: ${message}`);
      } catch {
        // Logging must never affect the process.
      }
      try {
        track(
          'observability.journey_rollup.failed',
          { status: 'failed' },
          { durationMs, daysReconciled: 0, edgesWritten: 0, sourceRowsConsidered: 0 },
        );
      } catch {
        // Telemetry must never affect the scheduler.
      }
    } finally {
      isRunning = false;
    }
  }

  function start(options?: { e2eMode?: boolean }): void {
    const e2eMode = options?.e2eMode ?? process.env.E2E_MODE === 'true';
    if (e2eMode) return;
    if (intervalTimer || startupTimer) return;

    startupTimer = setTimeout(() => {
      startupTimer = null;
      void tick();
    }, startupDelayMs);
    startupTimer.unref?.();

    intervalTimer = setInterval(() => {
      void tick();
    }, intervalMs);
    intervalTimer.unref?.();
  }

  function stop(): void {
    if (startupTimer) {
      clearTimeout(startupTimer);
      startupTimer = null;
    }
    if (intervalTimer) {
      clearInterval(intervalTimer);
      intervalTimer = null;
    }
  }

  return { start, stop, tick };
}

let singleton: JourneyAggregationScheduler | null = null;

function getScheduler(): JourneyAggregationScheduler {
  singleton ??= createJourneyAggregationScheduler();
  return singleton;
}

export function startJourneyAggregation(): void {
  getScheduler().start({ e2eMode: process.env.E2E_MODE === 'true' });
}

export function stopJourneyAggregation(): void {
  getScheduler().stop();
}

export function resetJourneyAggregationSchedulerForTests(): void {
  singleton?.stop();
  singleton = null;
}
