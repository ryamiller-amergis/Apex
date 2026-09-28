import { EXIT_FLUSH_GRACE_MS, exitAfterFlush } from '../utils/processExit';

describe('exitAfterFlush', () => {
  function harness() {
    const unref = jest.fn();
    const exit = jest.fn();
    const setExitCode = jest.fn();
    let scheduledCallback: (() => void) | null = null;
    let scheduledMs: number | null = null;
    const schedule = jest.fn((callback: () => void, ms: number) => {
      scheduledCallback = callback;
      scheduledMs = ms;
      return { unref };
    });

    return {
      unref,
      exit,
      setExitCode,
      schedule,
      elapseGracePeriod: () => {
        if (!scheduledCallback) throw new Error('no exit was scheduled');
        scheduledCallback();
      },
      scheduledDelay: () => scheduledMs,
    };
  }

  it('records the status code so a loop that does drain still exits correctly', async () => {
    const { exit, setExitCode, schedule } = harness();

    await exitAfterFlush(1, { exit, setExitCode, schedule });

    expect(setExitCode).toHaveBeenCalledWith(1);
    // Nothing is forced yet — the timer callback is what exits.
    expect(exit).not.toHaveBeenCalled();
  });

  it('forces the exit once the grace period elapses', async () => {
    const { exit, setExitCode, schedule, elapseGracePeriod, scheduledDelay } = harness();

    await exitAfterFlush(1, { exit, setExitCode, schedule });
    expect(scheduledDelay()).toBe(EXIT_FLUSH_GRACE_MS);

    elapseGracePeriod();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('unrefs the grace timer so it never keeps the process alive by itself', async () => {
    const { unref, exit, setExitCode, schedule } = harness();

    await exitAfterFlush(0, { exit, setExitCode, schedule });

    expect(unref).toHaveBeenCalledTimes(1);
  });

  it('flushes telemetry before scheduling the exit', async () => {
    const { exit, setExitCode, schedule } = harness();
    let flushed = false;
    const flush = jest.fn(async () => {
      await Promise.resolve();
      flushed = true;
    });

    await exitAfterFlush(1, { exit, setExitCode, schedule, flush });

    expect(flush).toHaveBeenCalledTimes(1);
    expect(flushed).toBe(true);
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  it('still exits when the flush fails', async () => {
    const { exit, setExitCode, schedule, elapseGracePeriod } = harness();
    const flush = jest.fn().mockRejectedValue(new Error('app insights unreachable'));

    await expect(
      exitAfterFlush(1, { exit, setExitCode, schedule, flush }),
    ).resolves.toBeUndefined();

    elapseGracePeriod();
    expect(exit).toHaveBeenCalledWith(1);
  });
});
