import { getDbPoolStats, type DbPoolStats } from '../db';
import { trackEvent } from './telemetry';

const SNAPSHOT_INTERVAL_MS = 30_000;

type TimerHandle = ReturnType<typeof setInterval>;
type TrackEventFn = typeof trackEvent;

type DbPoolTelemetryDependencies = {
  getDbPoolStats?: typeof getDbPoolStats;
  trackEvent?: TrackEventFn;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
};

export type DbPoolTelemetryScheduler = {
  start(): void;
  stop(): void;
};

function toMeasurements(stats: DbPoolStats): Record<string, number> {
  return {
    max: stats.max,
    total: stats.total,
    idle: stats.idle,
    active: stats.active,
    waiting: stats.waiting,
    saturation: stats.saturation,
  };
}

export function createDbPoolTelemetryScheduler(
  dependencies: DbPoolTelemetryDependencies = {},
): DbPoolTelemetryScheduler {
  const readStats = dependencies.getDbPoolStats ?? getDbPoolStats;
  const emit = dependencies.trackEvent ?? trackEvent;
  const setIntervalFn = dependencies.setIntervalFn ?? setInterval;
  const clearIntervalFn = dependencies.clearIntervalFn ?? clearInterval;

  let timer: TimerHandle | null = null;
  let started = false;

  const emitSnapshot = (): void => {
    try {
      const stats = readStats();
      const measurements = toMeasurements(stats);
      emit('database.pool.snapshot', undefined, measurements);
      if (stats.waiting > 0) {
        emit('database.pool.pressure', undefined, measurements);
      }
    } catch {
      console.error('[db-pool-telemetry] Failed to emit database pool telemetry');
    }
  };

  return {
    start(): void {
      if (started) return;
      started = true;
      emitSnapshot();
      timer = setIntervalFn(() => {
        emitSnapshot();
      }, SNAPSHOT_INTERVAL_MS);
      timer.unref?.();
    },

    stop(): void {
      started = false;
      if (timer) {
        clearIntervalFn(timer);
        timer = null;
      }
    },
  };
}

const defaultDbPoolTelemetryScheduler = createDbPoolTelemetryScheduler();

export function startDbPoolTelemetryScheduler(): void {
  defaultDbPoolTelemetryScheduler.start();
}

export function stopDbPoolTelemetryScheduler(): void {
  defaultDbPoolTelemetryScheduler.stop();
}
