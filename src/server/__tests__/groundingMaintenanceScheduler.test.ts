jest.mock('../db/drizzle', () => ({ db: {} }));

import type { PreWarmTarget } from '../../shared/types/runGrounding';
import { createGroundingMaintenanceScheduler } from '../services/groundingMaintenanceScheduler';

const target: PreWarmTarget = {
  provider: 'github',
  project: 'Apex',
  repository: 'AI-Pilot',
  branch: 'main',
};

describe('TBI-007 groundingMaintenanceScheduler', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('DoD-0 runs a staggered startup sweep, five-minute interval, and internal active-set events', async () => {
    // Arrange
    const sweep = jest.fn().mockResolvedValue(undefined);
    const preWarm = jest.fn().mockResolvedValue(undefined);
    const evictIdle = jest.fn().mockResolvedValue(undefined);
    const sharedEvictIdle = jest
      .fn()
      .mockResolvedValue({ scanned: 0, evicted: 0, protected: 0 });
    const evaluateActive = jest.fn().mockResolvedValue([]);
    const runLeaderSweep = jest.fn(
      async (operation: () => Promise<void>) => operation(),
    );
    let eventHandler: ((changed: PreWarmTarget) => void) | undefined;
    const unsubscribe = jest.fn();
    const scheduler = createGroundingMaintenanceScheduler({
      preWarmService: { sweep, preWarm },
      evictionService: { evictIdle },
      sharedReadCheckoutService: { evictIdle: sharedEvictIdle },
      stalenessService: { evaluateActive },
      runLeaderSweep,
      subscribe: (handler) => {
        eventHandler = handler;
        return unsubscribe;
      },
      startupDelayMs: 100,
      intervalMs: 5 * 60 * 1000,
    });

    // Act
    scheduler.start();
    await jest.advanceTimersByTimeAsync(100);
    eventHandler?.(target);
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(5 * 60 * 1000 - 100);
    scheduler.stop();

    // Assert
    expect(sweep).toHaveBeenCalledTimes(2);
    expect(evictIdle).toHaveBeenCalledTimes(2);
    // The shared read-only checkout sweep runs as a second eviction pass.
    expect(sharedEvictIdle).toHaveBeenCalledTimes(2);
    expect(preWarm).toHaveBeenCalledWith(target);
    expect(evaluateActive).toHaveBeenCalledWith(target);
    expect(evaluateActive).toHaveBeenCalledWith();
    expect(runLeaderSweep).toHaveBeenCalledTimes(2);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('DoD-4 prevents overlapping maintenance sweeps', async () => {
    // Arrange
    let releaseSweep!: () => void;
    const pendingSweep = new Promise<void>((resolve) => {
      releaseSweep = resolve;
    });
    const sweep = jest.fn(() => pendingSweep);
    const evictIdle = jest.fn().mockResolvedValue(undefined);
    const sharedEvictIdle = jest
      .fn()
      .mockResolvedValue({ scanned: 0, evicted: 0, protected: 0 });
    const evaluateActive = jest.fn().mockResolvedValue([]);
    const scheduler = createGroundingMaintenanceScheduler({
      preWarmService: {
        sweep,
        preWarm: jest.fn().mockResolvedValue(undefined),
      },
      evictionService: { evictIdle },
      sharedReadCheckoutService: { evictIdle: sharedEvictIdle },
      stalenessService: { evaluateActive },
      runLeaderSweep: async (operation) => operation(),
      subscribe: () => jest.fn(),
    });

    // Act
    const first = scheduler.runNow();
    const overlapping = scheduler.runNow();
    releaseSweep();
    await Promise.all([first, overlapping]);

    // Assert
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(evictIdle).toHaveBeenCalledTimes(1);
    expect(sharedEvictIdle).toHaveBeenCalledTimes(1);
    expect(evaluateActive).toHaveBeenCalledTimes(1);
  });

  it('allows only the distributed claim owner to run a scheduled sweep', async () => {
    const sweep = jest.fn().mockResolvedValue(undefined);
    const evictIdle = jest.fn().mockResolvedValue(undefined);
    const sharedEvictIdle = jest.fn().mockResolvedValue({
      scanned: 0,
      evicted: 0,
      protected: 0,
    });
    const evaluateActive = jest.fn().mockResolvedValue([]);
    const scheduler = createGroundingMaintenanceScheduler({
      preWarmService: {
        sweep,
        preWarm: jest.fn().mockResolvedValue(undefined),
      },
      evictionService: { evictIdle },
      sharedReadCheckoutService: { evictIdle: sharedEvictIdle },
      stalenessService: { evaluateActive },
      runLeaderSweep: jest.fn().mockRejectedValue(
        new Error(
          'Timed out waiting for repository cache lease: grounding-maintenance:sweep',
        ),
      ),
      subscribe: () => jest.fn(),
    });

    await expect(scheduler.runNow()).resolves.toBeUndefined();

    expect(sweep).not.toHaveBeenCalled();
    expect(evaluateActive).not.toHaveBeenCalled();
    expect(evictIdle).not.toHaveBeenCalled();
    expect(sharedEvictIdle).not.toHaveBeenCalled();
  });
});
