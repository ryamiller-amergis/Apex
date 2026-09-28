/**
 * TBI-021's tick — VT-07: the sweep runs on a jittered interval and never overlaps itself.
 *
 * Jitter is asserted at its bounds rather than by sampling `Math.random`, because the property that
 * matters is the range: a delay above the ceiling misses PBI-005's "within one sweep interval", and
 * a delay of zero is a busy loop against the database.
 *
 * The overlap guard is the other half. Without it a pass that takes longer than the interval
 * compounds into a queue of passes all waiting on the same advisory lock, and the backlog only ever
 * grows.
 */
jest.mock('../db', () => ({ __esModule: true, default: { end: jest.fn(), on: jest.fn() } }));
jest.mock('../db/drizzle', () => ({ db: {} }));
jest.mock('../services/featureFlagService', () => ({
  isFeatureOperational: jest.fn(),
}));
jest.mock('../services/playbookTerminalEventService', () => ({
  startPlaybookTerminalEventListener: jest.fn(),
  stopPlaybookTerminalEventListener: jest.fn(),
}));

import {
  computeReconciliationDelayMs,
  createPlaybookReconciliationScheduler,
  startPlaybookReconciliation,
  stopPlaybookReconciliation,
} from '../services/playbookReconciliationScheduler';
import { isFeatureOperational } from '../services/featureFlagService';
import { startPlaybookTerminalEventListener } from '../services/playbookTerminalEventService';

const mockIsFeatureOperational = isFeatureOperational as jest.MockedFunction<
  typeof isFeatureOperational
>;
const mockStartTerminalEventListener =
  startPlaybookTerminalEventListener as jest.MockedFunction<
    typeof startPlaybookTerminalEventListener
  >;

describe('VT-07 — the sweep interval is jittered downward from 60 seconds', () => {
  it('never exceeds the 60s ceiling and never collapses below 48s', () => {
    expect(computeReconciliationDelayMs(() => 0)).toBe(60_000);
    expect(computeReconciliationDelayMs(() => 1)).toBe(48_000);
    expect(computeReconciliationDelayMs(() => 0.5)).toBe(54_000);
  });

  it('stays in range for a generator that misbehaves', () => {
    // Defensive rather than hypothetical: an injected random that returns NaN would otherwise
    // produce NaN as a delay, which setInterval silently treats as 1ms — a busy loop.
    for (const sample of [NaN, -1, 2, Infinity]) {
      const delay = computeReconciliationDelayMs(() => sample);
      expect(delay).toBeGreaterThanOrEqual(48_000);
      expect(delay).toBeLessThanOrEqual(60_000);
    }
  });
});

describe('VT-07 — a pass never overlaps itself', () => {
  it('refuses a second runNow while the first is still going', async () => {
    let release: () => void = () => undefined;
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runPass = jest.fn().mockReturnValue(inFlight);

    const scheduler = createPlaybookReconciliationScheduler({ runPass });

    const first = scheduler.runNow();
    const second = await scheduler.runNow();

    expect(second).toBe(false);
    expect(runPass).toHaveBeenCalledTimes(1);

    release();
    await expect(first).resolves.toBe(true);

    // And the guard clears, so the next tick works.
    await expect(scheduler.runNow()).resolves.toBe(true);
    expect(runPass).toHaveBeenCalledTimes(2);
  });

  it('clears the guard when a pass throws, so one bad pass does not stop the sweep', async () => {
    const runPass = jest
      .fn()
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValue(undefined);
    const logError = jest.fn();

    const scheduler = createPlaybookReconciliationScheduler({ runPass, logError });

    await expect(scheduler.runNow()).resolves.toBe(false);
    expect(logError).toHaveBeenCalledWith(expect.any(String), 'connection reset');

    // The next pass must still run. A scheduler that stops sweeping after one transient error is
    // worse than no scheduler, because nothing reports that it stopped.
    await expect(scheduler.runNow()).resolves.toBe(true);
  });
});

describe('start and stop are idempotent', () => {
  it('starting twice creates one timer, and stopping clears it', () => {
    const setInterval = jest.spyOn(global, 'setInterval');
    const clearInterval = jest.spyOn(global, 'clearInterval');
    const scheduler = createPlaybookReconciliationScheduler({
      runPass: jest.fn().mockResolvedValue(undefined),
    });

    try {
      scheduler.start();
      scheduler.start();
      expect(setInterval).toHaveBeenCalledTimes(1);

      scheduler.stop();
      expect(clearInterval).toHaveBeenCalledTimes(1);

      scheduler.stop();
      expect(clearInterval).toHaveBeenCalledTimes(1);
    } finally {
      scheduler.stop();
      setInterval.mockRestore();
      clearInterval.mockRestore();
    }
  });
});

describe('application startup feature isolation', () => {
  afterEach(() => {
    stopPlaybookReconciliation();
    jest.restoreAllMocks();
  });

  it('does not install the listener or timer while Playbooks are disabled', async () => {
    mockIsFeatureOperational.mockResolvedValue(false);
    const setInterval = jest.spyOn(global, 'setInterval');

    await startPlaybookReconciliation();

    expect(mockStartTerminalEventListener).not.toHaveBeenCalled();
    expect(setInterval).not.toHaveBeenCalled();
  });

  it('leaves the application running without a listener or timer when the flag lookup fails', async () => {
    mockIsFeatureOperational.mockRejectedValue(new Error('database unavailable'));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const setInterval = jest.spyOn(global, 'setInterval');

    await expect(startPlaybookReconciliation()).resolves.toBeUndefined();

    expect(mockStartTerminalEventListener).not.toHaveBeenCalled();
    expect(setInterval).not.toHaveBeenCalled();
  });

  it('installs the listener and timer while Playbooks are operational', async () => {
    mockIsFeatureOperational.mockResolvedValue(true);
    const setInterval = jest.spyOn(global, 'setInterval');

    await startPlaybookReconciliation();

    expect(mockStartTerminalEventListener).toHaveBeenCalledTimes(1);
    expect(setInterval).toHaveBeenCalledTimes(1);
  });
});
