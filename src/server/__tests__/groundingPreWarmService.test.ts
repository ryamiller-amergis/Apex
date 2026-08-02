jest.mock('../db/drizzle', () => ({ db: {} }));

import type { PreWarmTarget } from '../../shared/types/runGrounding';
import { createGroundingPreWarmService } from '../services/groundingPreWarmService';

const target: PreWarmTarget = {
  provider: 'github',
  project: 'Apex',
  repository: 'AI-Pilot',
  branch: 'main',
};

const flushAsyncWork = () =>
  new Promise<void>((resolve) => setImmediate(resolve));

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

  it.each([false, true])(
    'AC-2 / TBI-008 DoD-2 enqueues a bounded branch move after %s coalesced refresh',
    async (coalesced) => {
      // Arrange
      const fromSha = 'a'.repeat(40);
      const toSha = 'b'.repeat(40);
      const readCachedSha = jest
        .fn()
        .mockResolvedValueOnce(fromSha)
        .mockResolvedValueOnce(toSha);
      const listChangedPaths = jest
        .fn()
        .mockResolvedValue(['src/server/a.ts', 'README.md']);
      const enqueueImpact = jest.fn();
      const refreshUnderLease = jest.fn().mockResolvedValue(undefined);
      const service = createGroundingPreWarmService({
        withLease: jest.fn(async (_key, operation) =>
          operation({
            signal: new AbortController().signal,
            assertOwned: jest.fn().mockResolvedValue(undefined),
          }),
        ),
        refreshUnderLease,
        wasRefreshedSince: jest.fn().mockReturnValue(coalesced),
        readCachedSha,
        listChangedPaths,
        enqueueImpact,
        telemetry: jest.fn(),
        now: () => 100,
      });

      // Act
      await service.preWarm(target);
      await flushAsyncWork();

      // Assert
      expect(refreshUnderLease).toHaveBeenCalledTimes(coalesced ? 0 : 1);
      expect(readCachedSha).toHaveBeenCalledTimes(2);
      expect(listChangedPaths).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'github',
          project: 'Apex',
          repo: 'AI-Pilot',
          branch: 'main',
        }),
        fromSha,
        toSha,
      );
      expect(enqueueImpact).toHaveBeenCalledWith({
        provider: 'github',
        project: 'Apex',
        repository: 'AI-Pilot',
        branch: 'main',
        fromSha,
        toSha,
        changedFiles: ['src/server/a.ts', 'README.md'],
      });
    },
  );

  it.each([
    ['unchanged', 'a'.repeat(40), 'a'.repeat(40)],
    ['missing old SHA', null, 'b'.repeat(40)],
    ['missing new SHA', 'a'.repeat(40), null],
  ])(
    'AC-3 / TBI-008 DoD-2 ignores %s branch state',
    async (_label, fromSha, toSha) => {
      // Arrange
      const enqueueImpact = jest.fn();
      const service = createGroundingPreWarmService({
        withLease: jest.fn(async (_key, operation) =>
          operation({
            signal: new AbortController().signal,
            assertOwned: jest.fn().mockResolvedValue(undefined),
          }),
        ),
        refreshUnderLease: jest.fn().mockResolvedValue(undefined),
        wasRefreshedSince: jest.fn().mockReturnValue(false),
        readCachedSha: jest
          .fn()
          .mockResolvedValueOnce(fromSha)
          .mockResolvedValueOnce(toSha),
        listChangedPaths: jest.fn(),
        enqueueImpact,
        telemetry: jest.fn(),
      });

      // Act
      await service.preWarm(target);
      await flushAsyncWork();

      // Assert
      expect(enqueueImpact).not.toHaveBeenCalled();
    },
  );

  it('AC-3 keeps pre-warm non-blocking and successful when impact diff fails', async () => {
    // Arrange
    const fromSha = 'a'.repeat(40);
    const toSha = 'b'.repeat(40);
    let rejectDiff!: (reason: Error) => void;
    const pendingDiff = new Promise<string[]>((_resolve, reject) => {
      rejectDiff = reject;
    });
    const enqueueImpact = jest.fn();
    const service = createGroundingPreWarmService({
      withLease: jest.fn(async (_key, operation) =>
        operation({
          signal: new AbortController().signal,
          assertOwned: jest.fn().mockResolvedValue(undefined),
        }),
      ),
      refreshUnderLease: jest.fn().mockResolvedValue(undefined),
      wasRefreshedSince: jest.fn().mockReturnValue(false),
      readCachedSha: jest
        .fn()
        .mockResolvedValueOnce(fromSha)
        .mockResolvedValueOnce(toSha),
      listChangedPaths: jest.fn().mockReturnValue(pendingDiff),
      enqueueImpact,
      telemetry: jest.fn(),
    });

    // Act / Assert
    await expect(service.preWarm(target)).resolves.toBeUndefined();
    rejectDiff(new Error('diff unavailable'));
    await flushAsyncWork();
    expect(enqueueImpact).not.toHaveBeenCalled();
  });

  it('AC-2 bounds and sanitizes changed paths before impact enqueue', async () => {
    // Arrange
    const enqueueImpact = jest.fn();
    const safePaths = Array.from(
      { length: 205 },
      (_, index) => `src/file-${index}.ts`,
    );
    const service = createGroundingPreWarmService({
      withLease: jest.fn(async (_key, operation) =>
        operation({
          signal: new AbortController().signal,
          assertOwned: jest.fn().mockResolvedValue(undefined),
        }),
      ),
      refreshUnderLease: jest.fn().mockResolvedValue(undefined),
      wasRefreshedSince: jest.fn().mockReturnValue(false),
      readCachedSha: jest
        .fn()
        .mockResolvedValueOnce('a'.repeat(40))
        .mockResolvedValueOnce('b'.repeat(40)),
      listChangedPaths: jest
        .fn()
        .mockResolvedValue([
          'C:\\private\\checkout.ts',
          '../outside.ts',
          '/absolute.ts',
          ...safePaths,
        ]),
      enqueueImpact,
      telemetry: jest.fn(),
    });

    // Act
    await service.preWarm(target);
    await flushAsyncWork();

    // Assert
    const changedFiles = enqueueImpact.mock.calls[0][0].changedFiles as string[];
    expect(changedFiles).toHaveLength(200);
    expect(changedFiles[0]).toBe('src/file-0.ts');
    expect(changedFiles).not.toEqual(
      expect.arrayContaining([
        'C:\\private\\checkout.ts',
        '../outside.ts',
        '/absolute.ts',
      ]),
    );
  });
});
