jest.mock('../db/drizzle', () => ({ db: {} }));

import {
  computeAdmissionSweepDelayMs,
  createAdmissionGovernorScheduler,
} from '../services/admissionGovernorScheduler';

describe('admission governor safety sweep (TBI-002 DoD-1/DoD-4, VT-06/VT-07)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('DoD-1/VT-06: Given missed triggers and free capacity, when one <=30s sweep fires, then stale recovery runs before admission', async () => {
    const order: string[] = [];
    const recoverStaleDispatchedRuns = jest.fn(async () => {
      order.push('recover');
      return { selected: 0, published: 0, failed: 0 };
    });
    const runAdmissionCycle = jest.fn(async (reason: string) => {
      order.push(`admit:${reason}`);
      return { admitted: 1, inFlight: 0, limit: 10 };
    });
    const scheduler = createAdmissionGovernorScheduler({
      recoverStaleDispatchedRuns,
      runAdmissionCycle,
      random: () => 0,
      logError: jest.fn(),
    });

    scheduler.start();
    scheduler.start();
    await jest.advanceTimersByTimeAsync(29_999);
    expect(runAdmissionCycle).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);

    expect(order).toEqual(['recover', 'admit:sweep']);
    expect(runAdmissionCycle).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  test('Performance NFR: Given any jitter sample, when delay resolves, then it stays within the documented 24-30 second window', () => {
    const delays = [
      computeAdmissionSweepDelayMs(() => 0),
      computeAdmissionSweepDelayMs(() => 0.5),
      computeAdmissionSweepDelayMs(() => 1),
      computeAdmissionSweepDelayMs(() => Number.NaN),
    ];

    expect(delays).toEqual([30_000, 27_000, 24_000, 30_000]);
    for (const delay of delays) {
      expect(delay).toBeGreaterThan(0);
      expect(delay).toBeLessThanOrEqual(30_000);
    }
  });

  test('DoD-1/VT-06: Given a sweep is still running, when another cycle is requested, then cycles never overlap', async () => {
    let releaseRecovery!: () => void;
    const pendingRecovery = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    const recoverStaleDispatchedRuns = jest.fn(async () => {
      await pendingRecovery;
      return { selected: 0, published: 0, failed: 0 };
    });
    const runAdmissionCycle = jest.fn().mockResolvedValue({
      admitted: 0,
      inFlight: 0,
      limit: 10,
    });
    const scheduler = createAdmissionGovernorScheduler({
      recoverStaleDispatchedRuns,
      runAdmissionCycle,
      logError: jest.fn(),
    });

    const first = scheduler.runNow();
    const overlapping = scheduler.runNow();
    await expect(overlapping).resolves.toBe(false);
    releaseRecovery();
    await expect(first).resolves.toBe(true);

    expect(recoverStaleDispatchedRuns).toHaveBeenCalledTimes(1);
    expect(runAdmissionCycle).toHaveBeenCalledTimes(1);
  });

  test('DoD-4/VT-07: Given recovery reports a publish failure, when the next sweep fires, then stale recovery is invoked again', async () => {
    const recoverStaleDispatchedRuns = jest.fn()
      .mockResolvedValueOnce({ selected: 1, published: 0, failed: 1 })
      .mockResolvedValueOnce({ selected: 1, published: 1, failed: 0 });
    const runAdmissionCycle = jest.fn().mockResolvedValue({
      admitted: 0,
      inFlight: 1,
      limit: 10,
    });
    const scheduler = createAdmissionGovernorScheduler({
      recoverStaleDispatchedRuns,
      runAdmissionCycle,
      random: () => 0,
      logError: jest.fn(),
    });

    scheduler.start();
    await jest.advanceTimersByTimeAsync(60_000);
    scheduler.stop();

    expect(recoverStaleDispatchedRuns).toHaveBeenCalledTimes(2);
    expect(runAdmissionCycle).toHaveBeenCalledTimes(2);
  });

  test('DoD-4/VT-07: Given recovery fails, when a sweep continues, then admission still runs and errors stay sanitized', async () => {
    const recoverStaleDispatchedRuns = jest.fn().mockRejectedValue(
      new Error('secret broker response containing CURSOR_API_KEY'),
    );
    const runAdmissionCycle = jest.fn().mockResolvedValue({
      admitted: 1,
      inFlight: 0,
      limit: 10,
    });
    const logError = jest.fn();
    const scheduler = createAdmissionGovernorScheduler({
      recoverStaleDispatchedRuns,
      runAdmissionCycle,
      logError,
    });

    await expect(scheduler.runNow()).resolves.toBe(true);

    expect(runAdmissionCycle).toHaveBeenCalledWith('sweep');
    const logged = JSON.stringify(logError.mock.calls);
    expect(logged).not.toContain('CURSOR_API_KEY');
    expect(logged).not.toMatch(/snapshot|prompt|workspace|secret/i);
  });
});
