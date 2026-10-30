jest.mock('../services/buildOrchestrator', () => ({ reconcileBuildRuns: jest.fn() }));

import type { BuildSweepOutcome } from '../services/buildOrchestrator/reconcile';
import {
  computeBuildSweepDelayMs,
  createBuildReconciliationScheduler,
} from '../services/buildReconciliationScheduler';

const OUTCOME: BuildSweepOutcome = {
  startedAt: '2026-10-30T00:00:00.000Z',
  durationMs: 5,
  skipped: false,
  flagSuspended: 0,
  completionsApplied: 0,
  launchesRecovered: 0,
  cancelRetries: 0,
  dispatched: 0,
  errors: 0,
};

describe('build reconciliation scheduler (VT-23, TBI-019 DoD-3)', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('keeps the delay between 16 and 20 seconds', () => {
    expect(computeBuildSweepDelayMs(() => 0)).toBe(20_000);
    expect(computeBuildSweepDelayMs(() => 1)).toBe(16_000);
    expect(computeBuildSweepDelayMs(() => Number.NaN)).toBe(20_000);
  });

  it('runs one pass at start, then on every tick, and records the last outcome', async () => {
    jest.useFakeTimers();
    const runPass = jest.fn(async () => OUTCOME);
    const scheduler = createBuildReconciliationScheduler({ runPass, random: () => 0 });

    scheduler.start();
    await Promise.resolve();
    expect(runPass).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(20_000);
    expect(runPass).toHaveBeenCalledTimes(2);
    expect(scheduler.lastOutcome()).toEqual(OUTCOME);
    scheduler.stop();
  });

  it('refuses a second runNow while one pass is still running', async () => {
    let release: () => void = () => undefined;
    const runPass = jest.fn(() => new Promise<BuildSweepOutcome>((resolve) => {
      release = () => resolve(OUTCOME);
    }));
    const scheduler = createBuildReconciliationScheduler({ runPass });

    const first = scheduler.runNow();
    await expect(scheduler.runNow()).resolves.toBe(false);
    release();
    await expect(first).resolves.toBe(true);
  });

  it('a failed pass is logged and does not stop the timer', async () => {
    jest.useFakeTimers();
    const logError = jest.fn();
    const runPass = jest.fn()
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValue(OUTCOME);
    const scheduler = createBuildReconciliationScheduler({ runPass, random: () => 1, logError });

    scheduler.start();
    await jest.advanceTimersByTimeAsync(16_000);

    expect(logError).toHaveBeenCalledWith('[build-reconciliation] sweep failed', 'db down');
    expect(runPass).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });
});
