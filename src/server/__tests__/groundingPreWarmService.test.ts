jest.mock('../db/drizzle', () => ({ db: {} }));

import type { PreWarmTarget } from '../../shared/types/runGrounding';
import { createGroundingPreWarmService } from '../services/groundingPreWarmService';

const target: PreWarmTarget = {
  provider: 'github',
  project: 'Apex',
  repository: 'AI-Pilot',
  branch: 'main',
};

describe('TBI-007 groundingPreWarmService', () => {
  it('DoD-0 coalesces concurrent refreshes and sweeps distinct active targets under a repository lease', async () => {
    // Arrange
    let releaseRefresh!: () => void;
    const refreshBlocked = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const refreshUnderLease = jest.fn(async () => refreshBlocked);
    const withLease = jest.fn(async (_key, operation) =>
      operation({
        signal: new AbortController().signal,
        assertOwned: jest.fn().mockResolvedValue(undefined),
      }),
    );
    const listActiveTargets = jest.fn().mockResolvedValue([target]);
    const service = createGroundingPreWarmService({
      listActiveTargets,
      withLease,
      refreshUnderLease,
      wasRefreshedSince: jest.fn().mockReturnValue(false),
      telemetry: jest.fn(),
      now: () => 100,
    });

    // Act
    const first = service.preWarm(target);
    const second = service.preWarm(target);
    releaseRefresh();
    await Promise.all([first, second]);
    await service.sweep();

    // Assert
    expect(withLease).toHaveBeenCalledTimes(2);
    expect(refreshUnderLease).toHaveBeenCalledTimes(2);
    expect(listActiveTargets).toHaveBeenCalledTimes(1);
    expect(withLease.mock.calls[0][0]).toMatch(/^repo-cache:/);
  });

  it('DoD-4 aborts on lease loss without retrying the mirror write', async () => {
    // Arrange
    const controller = new AbortController();
    const refreshUnderLease = jest.fn(async (_target, lease) => {
      controller.abort(new Error('lease lost'));
      lease.signal.throwIfAborted();
    });
    const service = createGroundingPreWarmService({
      listActiveTargets: jest.fn().mockResolvedValue([]),
      withLease: jest.fn(async (_key, operation) =>
        operation({
          signal: controller.signal,
          assertOwned: jest.fn().mockRejectedValue(new Error('lease lost')),
        }),
      ),
      refreshUnderLease,
      wasRefreshedSince: jest.fn().mockReturnValue(false),
      telemetry: jest.fn(),
    });

    // Act
    const result = service.preWarm(target);

    // Assert
    await expect(result).rejects.toThrow('lease lost');
    expect(refreshUnderLease).toHaveBeenCalledTimes(1);
  });

  it('DoD-0 coalesces queued cross-instance sweeps after the lease owner refreshes', async () => {
    // Arrange
    let refreshed = false;
    let leaseQueue = Promise.resolve();
    const lease = {
      signal: new AbortController().signal,
      assertOwned: jest.fn().mockResolvedValue(undefined),
    };
    const withLease = jest.fn((
      _key: string,
      operation: (context: typeof lease) => Promise<void>,
    ) => {
      const queued = leaseQueue.then(() => operation(lease));
      leaseQueue = queued.then(() => undefined);
      return queued;
    });
    const refreshUnderLease = jest.fn(async () => {
      refreshed = true;
    });
    const dependencies = {
      listActiveTargets: jest.fn().mockResolvedValue([target]),
      withLease,
      refreshUnderLease,
      wasRefreshedSince: jest.fn(() => refreshed),
      telemetry: jest.fn(),
      now: () => 100,
    };
    const firstInstance = createGroundingPreWarmService(dependencies);
    const secondInstance = createGroundingPreWarmService(dependencies);

    // Act
    await Promise.all([firstInstance.sweep(), secondInstance.sweep()]);

    // Assert
    expect(withLease).toHaveBeenCalledTimes(2);
    expect(refreshUnderLease).toHaveBeenCalledTimes(1);
  });
});
