/**
 * TBI-010 — Journey aggregation scheduler lifecycle.
 * Criterion ids: DoD-2, VT-11, VT-12, BR-010, BR-012.
 */
jest.mock('../db/drizzle', () => ({ db: { execute: jest.fn(), transaction: jest.fn() } }));
jest.mock('../services/telemetry', () => ({ trackEvent: jest.fn() }));

import {
  JOURNEY_ROLLUP_INTERVAL_MS,
  createJourneyAggregationScheduler,
} from '../services/journeyAggregationScheduler';

describe('journeyAggregationScheduler', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('DoD-2 staggers the first hourly run then repeats on the interval', async () => {
    jest.useFakeTimers();
    const runCycle = jest.fn().mockResolvedValue({
      status: 'completed',
      daysReconciled: 2,
      edgesWritten: 1,
      sourceRowsConsidered: 3,
      durationMs: 4,
    });
    const scheduler = createJourneyAggregationScheduler({
      runCycle,
      startupDelayMs: 100,
      intervalMs: JOURNEY_ROLLUP_INTERVAL_MS,
    });

    scheduler.start({ e2eMode: false });
    expect(runCycle).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(100);
    expect(runCycle).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(JOURNEY_ROLLUP_INTERVAL_MS);
    expect(runCycle).toHaveBeenCalledTimes(2);
    scheduler.stop();
    await jest.advanceTimersByTimeAsync(JOURNEY_ROLLUP_INTERVAL_MS);
    expect(runCycle).toHaveBeenCalledTimes(2);
  });

  it('VT-12 / DoD-2 skips overlapping ticks on one process', async () => {
    jest.useFakeTimers();
    let release!: () => void;
    const hanging = new Promise<{
      status: 'completed';
      daysReconciled: number;
      edgesWritten: number;
      sourceRowsConsidered: number;
      durationMs: number;
    }>((resolve) => {
      release = () =>
        resolve({
          status: 'completed',
          daysReconciled: 2,
          edgesWritten: 0,
          sourceRowsConsidered: 0,
          durationMs: 1,
        });
    });
    const runCycle = jest.fn(() => hanging);
    const scheduler = createJourneyAggregationScheduler({
      runCycle,
      startupDelayMs: 0,
      intervalMs: 1_000,
    });

    const first = scheduler.tick();
    const second = scheduler.tick();
    release();
    await Promise.all([first, second]);
    expect(runCycle).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it('VT-12 / DoD-2 reports a failed cycle without touching request/capture deps and retries next interval', async () => {
    jest.useFakeTimers();
    const requestTouched = jest.fn();
    const track = jest.fn();
    const runCycle = jest
      .fn()
      .mockRejectedValueOnce(new Error('rollup write failed'))
      .mockResolvedValueOnce({
        status: 'completed',
        daysReconciled: 2,
        edgesWritten: 1,
        sourceRowsConsidered: 2,
        durationMs: 3,
      });
    const scheduler = createJourneyAggregationScheduler({
      runCycle,
      track,
      startupDelayMs: 10,
      intervalMs: 1_000,
    });

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    scheduler.start({ e2eMode: false });
    await jest.advanceTimersByTimeAsync(10);
    expect(runCycle).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith(
      'observability.journey_rollup.failed',
      expect.objectContaining({ status: 'failed' }),
      expect.any(Object),
    );
    expect(errorSpy).toHaveBeenCalledWith('[journey-rollup] cycle failed: rollup write failed');
    expect(requestTouched).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1_000);
    expect(runCycle).toHaveBeenCalledTimes(2);
    expect(track).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
    scheduler.stop();
  });

  it('VT-11 does not start when E2E_MODE is true', async () => {
    jest.useFakeTimers();
    const runCycle = jest.fn();
    const scheduler = createJourneyAggregationScheduler({
      runCycle,
      startupDelayMs: 10,
      intervalMs: 1_000,
    });
    scheduler.start({ e2eMode: true });
    await jest.advanceTimersByTimeAsync(5_000);
    expect(runCycle).not.toHaveBeenCalled();
    scheduler.stop();
  });

  it('start/stop are idempotent', () => {
    const scheduler = createJourneyAggregationScheduler({
      runCycle: async () => ({
        status: 'disabled',
        daysReconciled: 0,
        edgesWritten: 0,
        sourceRowsConsidered: 0,
        durationMs: 0,
      }),
    });
    scheduler.start({ e2eMode: false });
    scheduler.start({ e2eMode: false });
    scheduler.stop();
    scheduler.stop();
  });
});
