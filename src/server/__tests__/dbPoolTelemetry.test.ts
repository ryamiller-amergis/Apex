jest.mock('../services/telemetry', () => ({
  trackEvent: jest.fn(),
}));

import { getDbPoolStats } from '../db';
import { createDbPoolTelemetryScheduler } from '../services/dbPoolTelemetry';
import { trackEvent } from '../services/telemetry';

type PoolSnapshot = Parameters<typeof getDbPoolStats>[0];

describe('database pool telemetry', () => {
  describe('getDbPoolStats', () => {
    it('computes idle, active, waiting, and saturation from pool counters', () => {
      const stats = getDbPoolStats({
        options: { max: 10 },
        totalCount: 6,
        idleCount: 2,
        waitingCount: 3,
      } as PoolSnapshot);

      expect(stats).toEqual({
        max: 10,
        total: 6,
        idle: 2,
        active: 4,
        waiting: 3,
        saturation: 0.4,
      });
    });

    it('clamps invalid max values and never returns negative active counts', () => {
      const stats = getDbPoolStats({
        options: { max: Number.NaN },
        totalCount: 2,
        idleCount: 5,
        waitingCount: -1,
      } as PoolSnapshot);

      expect(stats).toEqual({
        max: 0,
        total: 2,
        idle: 5,
        active: 0,
        waiting: 0,
        saturation: 0,
      });
    });
  });

  describe('createDbPoolTelemetryScheduler', () => {
    const mockTrackEvent = jest.mocked(trackEvent);

    beforeEach(() => {
      jest.useFakeTimers();
      mockTrackEvent.mockReset();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('emits immediately and every 30 seconds without querying the database', async () => {
      const getPoolStats = jest.fn().mockReturnValue({
        max: 8,
        total: 4,
        idle: 1,
        active: 3,
        waiting: 0,
        saturation: 0.375,
      });
      const clearIntervalFn = jest.fn();
      const unref = jest.fn();
      let intervalCallback: (() => void) | undefined;

      const scheduler = createDbPoolTelemetryScheduler({
        getDbPoolStats: getPoolStats,
        setIntervalFn: ((callback: () => void, _delayMs: number) => {
          intervalCallback = callback;
          return { unref } as ReturnType<typeof setInterval>;
        }) as typeof setInterval,
        clearIntervalFn,
      });

      scheduler.start();

      expect(getPoolStats).toHaveBeenCalledTimes(1);
      expect(mockTrackEvent).toHaveBeenCalledWith(
        'database.pool.snapshot',
        undefined,
        {
          max: 8,
          total: 4,
          idle: 1,
          active: 3,
          waiting: 0,
          saturation: 0.375,
        },
      );
      expect(unref).toHaveBeenCalledTimes(1);

      intervalCallback?.();

      expect(getPoolStats).toHaveBeenCalledTimes(2);
      expect(mockTrackEvent).toHaveBeenCalledTimes(2);
    });

    it('emits pressure telemetry when clients are waiting for a connection', () => {
      const scheduler = createDbPoolTelemetryScheduler({
        getDbPoolStats: () => ({
          max: 5,
          total: 5,
          idle: 0,
          active: 5,
          waiting: 2,
          saturation: 1,
        }),
      });

      scheduler.start();

      expect(mockTrackEvent).toHaveBeenNthCalledWith(
        1,
        'database.pool.snapshot',
        undefined,
        {
          max: 5,
          total: 5,
          idle: 0,
          active: 5,
          waiting: 2,
          saturation: 1,
        },
      );
      expect(mockTrackEvent).toHaveBeenNthCalledWith(
        2,
        'database.pool.pressure',
        undefined,
        {
          max: 5,
          total: 5,
          idle: 0,
          active: 5,
          waiting: 2,
          saturation: 1,
        },
      );

      scheduler.stop();
    });

    it('starts only once when start is called repeatedly', () => {
      const getPoolStats = jest.fn().mockReturnValue({
        max: 5,
        total: 1,
        idle: 1,
        active: 0,
        waiting: 0,
        saturation: 0,
      });
      const setIntervalFn = jest.fn(() => ({
        unref: jest.fn(),
      })) as unknown as typeof setInterval;
      const scheduler = createDbPoolTelemetryScheduler({
        getDbPoolStats: getPoolStats,
        setIntervalFn,
      });

      scheduler.start();
      scheduler.start();

      expect(getPoolStats).toHaveBeenCalledTimes(1);
      expect(setIntervalFn).toHaveBeenCalledTimes(1);
      expect(mockTrackEvent).toHaveBeenCalledTimes(1);
      scheduler.stop();
    });

    it('keeps emitting later snapshots after a telemetry failure', () => {
      const getPoolStats = jest.fn().mockReturnValue({
        max: 5,
        total: 4,
        idle: 1,
        active: 3,
        waiting: 0,
        saturation: 0.6,
      });
      const clearIntervalFn = jest.fn();
      let intervalCallback: (() => void) | undefined;
      mockTrackEvent
        .mockImplementationOnce(() => {
          throw new Error('telemetry unavailable');
        })
        .mockImplementation(() => undefined);

      const scheduler = createDbPoolTelemetryScheduler({
        getDbPoolStats: getPoolStats,
        setIntervalFn: ((callback: () => void, _delayMs: number) => {
          intervalCallback = callback;
          return { unref: jest.fn() } as ReturnType<typeof setInterval>;
        }) as typeof setInterval,
        clearIntervalFn,
      });

      expect(() => scheduler.start()).not.toThrow();

      intervalCallback?.();

      expect(getPoolStats).toHaveBeenCalledTimes(2);
      expect(mockTrackEvent).toHaveBeenCalledTimes(2);
      scheduler.stop();
    });

    it('clears the timer and resets state when stopped', () => {
      const timer = { unref: jest.fn() } as ReturnType<typeof setInterval>;
      const clearIntervalFn = jest.fn();
      const scheduler = createDbPoolTelemetryScheduler({
        getDbPoolStats: () => ({
          max: 5,
          total: 2,
          idle: 1,
          active: 1,
          waiting: 0,
          saturation: 0.2,
        }),
        setIntervalFn: (() => timer) as typeof setInterval,
        clearIntervalFn,
      });

      scheduler.start();
      scheduler.stop();
      scheduler.start();

      expect(clearIntervalFn).toHaveBeenCalledWith(timer);
      expect(mockTrackEvent).toHaveBeenCalledTimes(2);
    });
  });
});
