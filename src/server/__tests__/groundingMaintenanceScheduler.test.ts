jest.mock('../db/drizzle', () => ({ db: {} }));

import type { PreWarmTarget } from '../../shared/types/runGrounding';
import { createGroundingMaintenanceScheduler } from '../services/groundingMaintenanceScheduler';

const target: PreWarmTarget = {
  provider: 'github',
  project: 'Apex',
  repository: 'AI-Pilot',
  branch: 'main',
};

function stubRepoCacheEviction() {
  return jest.fn().mockResolvedValue({
    scanned: 0,
    evicted: 0,
    protected: 0,
    bytesBefore: 0,
    bytesAfter: 0,
    maxBytes: 0,
  });
}

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
    const evictOverBudget = stubRepoCacheEviction();
    const evaluateActive = jest.fn().mockResolvedValue([]);
    const runIfDue = jest.fn().mockResolvedValue({
      due: false,
      etDate: '2026-08-20',
      considered: 0,
      reGrounded: 0,
      skippedRunning: 0,
      skippedFresh: 0,
      skippedIneligible: 0,
      errors: 0,
    });
    const runLeaderSweep = jest.fn(
      async (operation: () => Promise<void>) => operation(),
    );
    let eventHandler: ((changed: PreWarmTarget) => void) | undefined;
    const unsubscribe = jest.fn();
    const scheduler = createGroundingMaintenanceScheduler({
      preWarmService: { sweep, preWarm },
      evictionService: { evictIdle },
      sharedReadCheckoutService: { evictIdle: sharedEvictIdle },
      repoCacheEvictionService: { evictOverBudget },
      stalenessService: { evaluateActive },
      nightlyIdleReGround: { runIfDue },
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
    // The bare-mirror budget sweep runs as a third.
    expect(evictOverBudget).toHaveBeenCalledTimes(2);
    expect(preWarm).toHaveBeenCalledWith(target);
    expect(evaluateActive).toHaveBeenCalledWith(target);
    expect(evaluateActive).toHaveBeenCalledWith(undefined, { includeProject: undefined });
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
      repoCacheEvictionService: { evictOverBudget: stubRepoCacheEviction() },
      stalenessService: { evaluateActive },
      nightlyIdleReGround: {
        runIfDue: jest.fn().mockResolvedValue({
          due: false,
          etDate: '2026-08-20',
          considered: 0,
          reGrounded: 0,
          skippedRunning: 0,
          skippedFresh: 0,
          skippedIneligible: 0,
          errors: 0,
        }),
      },
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

  it('still runs the evictions when the pre-warm sweep fails, then reports the failure', async () => {
    const sweep = jest.fn().mockRejectedValue(new Error('disk-low'));
    const evaluateActive = jest.fn().mockResolvedValue([]);
    const evictIdle = jest.fn().mockResolvedValue(undefined);
    const sharedEvictIdle = jest.fn().mockResolvedValue({ scanned: 0, evicted: 0, protected: 0 });
    const evictOverBudget = stubRepoCacheEviction();
    const runIfDue = jest.fn().mockResolvedValue({
      due: false,
      etDate: '2026-08-20',
      considered: 0,
      reGrounded: 0,
      skippedRunning: 0,
      skippedFresh: 0,
      skippedIneligible: 0,
      errors: 0,
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const scheduler = createGroundingMaintenanceScheduler({
      preWarmService: { sweep, preWarm: jest.fn().mockResolvedValue(undefined) },
      evictionService: { evictIdle },
      sharedReadCheckoutService: { evictIdle: sharedEvictIdle },
      repoCacheEvictionService: { evictOverBudget },
      stalenessService: { evaluateActive },
      nightlyIdleReGround: { runIfDue },
      runLeaderSweep: async (operation) => operation(),
      subscribe: () => jest.fn(),
    });

    await expect(scheduler.runNow()).rejects.toThrow('Grounding maintenance steps failed: pre-warm');

    expect(evaluateActive).toHaveBeenCalledTimes(1);
    expect(evictIdle).toHaveBeenCalledTimes(1);
    expect(sharedEvictIdle).toHaveBeenCalledTimes(1);
    expect(evictOverBudget).toHaveBeenCalledTimes(1);
    expect(runIfDue).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('step=pre-warm failed: disk-low'));
    warn.mockRestore();
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
      nightlyIdleReGround: {
        runIfDue: jest.fn().mockResolvedValue({
          due: false,
          etDate: '2026-08-20',
          considered: 0,
          reGrounded: 0,
          skippedRunning: 0,
          skippedFresh: 0,
          skippedIneligible: 0,
          errors: 0,
        }),
      },
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

  describe('GROUNDING_MAINTENANCE_MODE', () => {
    function stubs() {
      return {
        sweep: jest.fn().mockResolvedValue(undefined),
        preWarm: jest.fn().mockResolvedValue(undefined),
        evictIdle: jest.fn().mockResolvedValue(undefined),
        sharedEvictIdle: jest.fn().mockResolvedValue({ scanned: 0, evicted: 0, protected: 0 }),
        evictOverBudget: stubRepoCacheEviction(),
        evaluateActive: jest.fn().mockResolvedValue([]),
        runIfDue: jest.fn().mockResolvedValue({
          due: false,
          etDate: '2026-08-20',
          considered: 0,
          reGrounded: 0,
          skippedRunning: 0,
          skippedFresh: 0,
          skippedIneligible: 0,
          errors: 0,
        }),
        runLeaderSweep: jest.fn(
          async (operation: () => Promise<void>, _leaseWindowMs: number, _claimKey: string) =>
            operation(),
        ),
        subscribe: jest.fn(() => jest.fn()),
      };
    }

    function build(
      s: ReturnType<typeof stubs>,
      mode?: string,
      isV2Project?: (project: string) => Promise<boolean>,
    ) {
      return createGroundingMaintenanceScheduler({
        ...(isV2Project ? { isV2Project } : {}),
        preWarmService: { sweep: s.sweep, preWarm: s.preWarm },
        evictionService: { evictIdle: s.evictIdle },
        sharedReadCheckoutService: { evictIdle: s.sharedEvictIdle },
        repoCacheEvictionService: { evictOverBudget: s.evictOverBudget },
        stalenessService: { evaluateActive: s.evaluateActive },
        nightlyIdleReGround: { runIfDue: s.runIfDue },
        runLeaderSweep: s.runLeaderSweep,
        subscribe: s.subscribe,
        startupDelayMs: 100,
        ...(mode !== undefined ? { mode } : {}),
      });
    }

    it('cleanup-only runs only the evictions, under its own claim key, with no pre-warm subscription', async () => {
      const s = stubs();
      const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      const scheduler = build(s, 'cleanup-only');

      scheduler.start();
      await jest.advanceTimersByTimeAsync(100);
      scheduler.stop();

      expect(scheduler.mode).toBe('cleanup-only');
      expect(s.subscribe).not.toHaveBeenCalled();
      expect(s.sweep).not.toHaveBeenCalled();
      expect(s.evaluateActive).not.toHaveBeenCalled();
      expect(s.runIfDue).not.toHaveBeenCalled();
      expect(s.evictIdle).toHaveBeenCalledTimes(1);
      expect(s.sharedEvictIdle).toHaveBeenCalledTimes(1);
      expect(s.evictOverBudget).toHaveBeenCalledTimes(1);
      expect(s.runLeaderSweep).toHaveBeenCalledWith(
        expect.any(Function),
        expect.any(Number),
        'grounding-maintenance:sweep:cleanup-only',
      );
      log.mockRestore();
    });

    it('full keeps the existing claim key and every step', async () => {
      const s = stubs();
      const scheduler = build(s, 'full');

      await scheduler.runNow();

      expect(s.sweep).toHaveBeenCalledTimes(1);
      expect(s.evaluateActive).toHaveBeenCalledTimes(1);
      expect(s.runIfDue).toHaveBeenCalledTimes(1);
      expect(s.evictOverBudget).toHaveBeenCalledTimes(1);
      expect(s.runLeaderSweep).toHaveBeenCalledWith(
        expect.any(Function),
        expect.any(Number),
        'grounding-maintenance:sweep',
      );
    });

    it('disk-only only compacts this host repo cache', async () => {
      const s = stubs();
      const scheduler = build(s, 'disk-only');

      await scheduler.runNow();

      expect(scheduler.mode).toBe('disk-only');
      expect(s.sweep).not.toHaveBeenCalled();
      expect(s.evaluateActive).not.toHaveBeenCalled();
      expect(s.runIfDue).not.toHaveBeenCalled();
      expect(s.evictIdle).not.toHaveBeenCalled();
      expect(s.sharedEvictIdle).not.toHaveBeenCalled();
      expect(s.evictOverBudget).toHaveBeenCalledTimes(1);
      expect(s.runLeaderSweep).toHaveBeenCalledWith(
        expect.any(Function),
        expect.any(Number),
        'grounding-maintenance:sweep:disk-only',
      );
    });

    const isV2Project = async (project: string) => project === 'Apex';

    async function includedProjects(
      filter: ((project: string) => Promise<boolean>) | undefined,
    ): Promise<string[]> {
      expect(filter).toBeDefined();
      const projects = ['Apex', 'MatterWorx'];
      const decisions = await Promise.all(projects.map((project) => filter!(project)));
      return projects.filter((_, index) => decisions[index]);
    }

    it('legacy-projects grounds only non-V2 projects and leaves the workspace share alone', async () => {
      const s = stubs();
      const scheduler = build(s, 'legacy-projects', isV2Project);

      await scheduler.runNow();

      expect(scheduler.mode).toBe('legacy-projects');
      expect(await includedProjects(s.sweep.mock.calls[0][0].includeProject)).toEqual(['MatterWorx']);
      expect(await includedProjects(s.evaluateActive.mock.calls[0][1].includeProject)).toEqual(['MatterWorx']);
      expect(s.runIfDue).toHaveBeenCalledWith(expect.objectContaining({ materialize: true }));
      expect(s.evictIdle).not.toHaveBeenCalled();
      expect(s.sharedEvictIdle).not.toHaveBeenCalled();
      expect(s.evictOverBudget).toHaveBeenCalledTimes(1);
      expect(s.runLeaderSweep).toHaveBeenCalledWith(
        expect.any(Function),
        expect.any(Number),
        'grounding-maintenance:sweep:legacy-projects',
      );
    });

    it('v2-projects grounds only V2 projects, cleans the share, re-pins without checkout, and keeps its mirrors', async () => {
      const s = stubs();
      const scheduler = build(s, 'v2-projects', isV2Project);

      await scheduler.runNow();

      expect(await includedProjects(s.sweep.mock.calls[0][0].includeProject)).toEqual(['Apex']);
      expect(await includedProjects(s.runIfDue.mock.calls[0][0].includeProject)).toEqual(['Apex']);
      expect(s.runIfDue).toHaveBeenCalledWith(expect.objectContaining({ materialize: false }));
      expect(s.evictIdle).toHaveBeenCalledTimes(1);
      expect(s.sharedEvictIdle).toHaveBeenCalledTimes(1);
      expect(s.evictOverBudget).not.toHaveBeenCalled();
      expect(s.runLeaderSweep).toHaveBeenCalledWith(
        expect.any(Function),
        expect.any(Number),
        'grounding-maintenance:sweep:v2-projects',
      );
    });

    it('keeps a project on App Service when the V2 flag cannot be read', async () => {
      const unreadable = jest.fn().mockRejectedValue(new Error('db down'));
      const legacy = stubs();
      const v2 = stubs();

      await build(legacy, 'legacy-projects', unreadable).runNow();
      await build(v2, 'v2-projects', unreadable).runNow();

      expect(await includedProjects(legacy.sweep.mock.calls[0][0].includeProject)).toEqual(['Apex', 'MatterWorx']);
      expect(await includedProjects(v2.sweep.mock.calls[0][0].includeProject)).toEqual([]);
    });

    it('skips event pre-warm for a project this host does not ground', async () => {
      const s = stubs();
      let handler: ((changed: PreWarmTarget) => void) | undefined;
      s.subscribe.mockImplementation(((next: (changed: PreWarmTarget) => void) => {
        handler = next;
        return jest.fn();
      }) as () => jest.Mock);
      const scheduler = build(s, 'legacy-projects', isV2Project);

      scheduler.start();
      handler?.(target);
      handler?.({ ...target, project: 'MatterWorx' });
      await jest.advanceTimersByTimeAsync(0);
      scheduler.stop();

      expect(s.preWarm).toHaveBeenCalledTimes(1);
      expect(s.preWarm).toHaveBeenCalledWith({ ...target, project: 'MatterWorx' });
    });

    it('reads the mode from the environment by default', () => {
      const original = process.env.GROUNDING_MAINTENANCE_MODE;
      process.env.GROUNDING_MAINTENANCE_MODE = 'cleanup-only';
      try {
        expect(build(stubs()).mode).toBe('cleanup-only');
      } finally {
        if (original === undefined) delete process.env.GROUNDING_MAINTENANCE_MODE;
        else process.env.GROUNDING_MAINTENANCE_MODE = original;
      }
    });

    it('falls back to full with a warning for an unknown value', async () => {
      const s = stubs();
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const scheduler = build(s, 'staging');

      await scheduler.runNow();

      expect(scheduler.mode).toBe('full');
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('unknown GROUNDING_MAINTENANCE_MODE="staging"'),
      );
      expect(s.sweep).toHaveBeenCalledTimes(1);
      expect(s.runLeaderSweep).toHaveBeenCalledWith(
        expect.any(Function),
        expect.any(Number),
        'grounding-maintenance:sweep',
      );
      warn.mockRestore();
    });
  });
});
