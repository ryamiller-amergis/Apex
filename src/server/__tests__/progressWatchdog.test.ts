jest.mock('../services/telemetry', () => ({
  trackEvent: jest.fn(),
  flushTelemetry: jest.fn().mockResolvedValue(undefined),
}));

import { createProgressWatchdog, exitWhenStalled } from '../utils/progressWatchdog';
import { createSingleFlight, stuckAfterForInterval } from '../utils/singleFlight';

describe('progressWatchdog', () => {
  it('reports a loop only once its beat is overdue', () => {
    let clock = 0;
    const watchdog = createProgressWatchdog(() => clock);
    watchdog.beat('loop', 1_000);
    clock = 1_000;
    expect(watchdog.stalled()).toEqual([]);
    clock = 1_500;
    expect(watchdog.stalled()).toEqual([{ name: 'loop', overdueMs: 500 }]);
    watchdog.beat('loop', 1_000);
    expect(watchdog.stalled()).toEqual([]);
    clock = 5_000;
    watchdog.clear('loop');
    expect(watchdog.stalled()).toEqual([]);
  });

  it('exits once when a loop stalls', async () => {
    jest.useFakeTimers();
    try {
      let clock = 0;
      const watchdog = createProgressWatchdog(() => clock);
      const exit = jest.fn();
      jest.spyOn(console, 'error').mockImplementation(() => {});
      watchdog.beat('job-loop', 10_000);
      exitWhenStalled('documents-v2', watchdog, { pollMs: 1_000, exit });

      clock = 5_000;
      await jest.advanceTimersByTimeAsync(1_000);
      expect(console.error).not.toHaveBeenCalled();

      clock = 20_000;
      await jest.advanceTimersByTimeAsync(1_000);
      await jest.advanceTimersByTimeAsync(1_000);

      expect(console.error).toHaveBeenCalledTimes(1);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('"event":"ServiceStalled","service":"documents-v2","loops":"job-loop"'),
      );
      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      jest.useRealTimers();
      jest.restoreAllMocks();
    }
  });
});

describe('singleFlight', () => {
  it('skips an overlapping run, then replaces a stuck one', async () => {
    let clock = 0;
    const log = jest.fn();
    const guard = createSingleFlight({ name: 'demo', stuckAfterMs: 1_000, now: () => clock, log });
    let releaseFirst!: () => void;
    const first = guard.run(() => new Promise<void>((resolve) => { releaseFirst = resolve; }));

    expect(guard.isRunning()).toBe(true);
    await expect(guard.run(async () => {})).resolves.toBe(false);

    clock = 1_000;
    const second = jest.fn().mockResolvedValue(undefined);
    await expect(guard.run(second)).resolves.toBe(true);
    expect(second).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[demo] previous run stuck for 1000ms'));

    const third = guard.run(() => new Promise<void>(() => {}));
    releaseFirst();
    await first;
    expect(guard.isRunning()).toBe(true);
    void third;
  });

  it('lets a late finisher exit without clearing the run that replaced it', () => {
    let clock = 0;
    const guard = createSingleFlight({ name: 'demo', stuckAfterMs: 100, now: () => clock, log: () => {} });
    const stuck = guard.tryEnter();
    expect(guard.tryEnter()).toBeNull();

    clock = 100;
    const replacement = guard.tryEnter();
    expect(replacement).not.toBeNull();

    guard.exit(stuck!);
    expect(guard.isRunning()).toBe(true);
    guard.exit(replacement!);
    expect(guard.isRunning()).toBe(false);
  });

  it('sets the stuck limit to twice the interval with a 30-minute floor', () => {
    expect(stuckAfterForInterval(5 * 60_000)).toBe(30 * 60_000);
    expect(stuckAfterForInterval(60 * 60_000)).toBe(2 * 60 * 60_000);
  });
});
