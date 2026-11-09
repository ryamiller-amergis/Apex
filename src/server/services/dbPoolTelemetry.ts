import fs from 'fs';
import os from 'os';
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
  /**
   * One libuv-pool operation. Its latency is the pool's queue wait, which is
   * also what DNS lookups for new Postgres connections wait behind.
   */
  probeThreadpool?: () => Promise<unknown>;
  now?: () => number;
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

export function probeThreadpoolWithLocalStat(): Promise<unknown> {
  return fs.promises.stat(os.tmpdir());
}

export function createDbPoolTelemetryScheduler(
  dependencies: DbPoolTelemetryDependencies = {},
): DbPoolTelemetryScheduler {
  const readStats = dependencies.getDbPoolStats ?? getDbPoolStats;
  const emit = dependencies.trackEvent ?? trackEvent;
  const setIntervalFn = dependencies.setIntervalFn ?? setInterval;
  const clearIntervalFn = dependencies.clearIntervalFn ?? clearInterval;
  const probeThreadpool = dependencies.probeThreadpool;
  const now = dependencies.now ?? Date.now;

  let timer: TimerHandle | null = null;
  let started = false;
  let probeStartedAt: number | null = null;

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

  const emitThreadpoolProbe = (): void => {
    if (!probeThreadpool) return;
    if (probeStartedAt !== null) {
      try {
        emit('runtime.threadpool.probe', undefined, {
          waitMs: now() - probeStartedAt,
          pending: 1,
        });
      } catch {
        console.error('[db-pool-telemetry] Failed to emit thread pool telemetry');
      }
      return;
    }
    const startedAt = now();
    probeStartedAt = startedAt;
    probeThreadpool()
      .then(() => {
        emit('runtime.threadpool.probe', undefined, {
          waitMs: now() - startedAt,
          pending: 0,
        });
      })
      .catch(() => {
        console.error('[db-pool-telemetry] Thread pool probe failed');
      })
      .finally(() => {
        if (probeStartedAt === startedAt) probeStartedAt = null;
      });
  };

  const tick = (): void => {
    emitSnapshot();
    emitThreadpoolProbe();
  };

  return {
    start(): void {
      if (started) return;
      started = true;
      tick();
      timer = setIntervalFn(() => {
        tick();
      }, SNAPSHOT_INTERVAL_MS);
      timer.unref?.();
    },

    stop(): void {
      started = false;
      probeStartedAt = null;
      if (timer) {
        clearIntervalFn(timer);
        timer = null;
      }
    },
  };
}

const defaultDbPoolTelemetryScheduler = createDbPoolTelemetryScheduler({
  probeThreadpool: probeThreadpoolWithLocalStat,
});

export function startDbPoolTelemetryScheduler(): void {
  defaultDbPoolTelemetryScheduler.start();
}

export function stopDbPoolTelemetryScheduler(): void {
  defaultDbPoolTelemetryScheduler.stop();
}
